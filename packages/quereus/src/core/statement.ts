import { createLogger } from '../common/logger.js';
import { type SqlValue, StatusCode, type Row, type SqlParameters, type StatementOptions, type DeepReadonly, isSqlValue, describeSqlValueViolation } from '../common/types.js';
import { MisuseError, QuereusError, throwIfAborted } from '../common/errors.js';
import type { Database } from './database.js';
import { isRelationType, type ColumnDef, type ScalarType } from '../common/datatype.js';
import { Parser } from '../parser/parser.js';
import type { Statement as ASTStatement } from '../parser/ast.js';
import type { BlockNode } from '../planner/nodes/block.js';
import { emitPlanNode } from '../runtime/emitters.js';
import { Scheduler } from '../runtime/scheduler.js';
import type { InstructionTracer, RuntimeContext } from '../runtime/types.js';
import { createStrictRowContextMap, wrapTableContextsStrict } from '../runtime/strict-fork.js';
import { Cached } from '../util/cached.js';
import { isAsyncIterable, disconnectVTable } from '../runtime/utils.js';
import type { VirtualTable } from '../vtab/table.js';
import { generateInstructionProgram, serializePlanTree } from '../planner/debug.js';
import { EmissionContext } from '../runtime/emission-context.js';
import type { SchemaDependency } from '../planner/planning-context.js';
import { getParameterTypes } from './param.js';
import { rowToObject } from './utils.js';
import { getPhysicalType, physicalTypeName, PhysicalType } from '../types/logical-type.js';
import { wrapAsyncIterator } from '../util/async-iterator.js';
import { combineAbortSignals } from '../util/abort-signal.js';
import { analyzeChangeScope, type ChangeScope } from '../planner/analysis/change-scope.js';
import { collectScalarRequiredParams } from '../planner/analysis/scalar-param-usage.js';
import { isObjectClassValue } from '../util/comparison.js';
import { canonicalizeSqlValue } from '../util/numeric-canonical.js';
import { astToString } from '../emit/ast-stringify.js';

const log = createLogger('core:statement');
const errorLog = log.extend('error');

/**
 * Represents a prepared SQL statement.
 */
export class Statement {
	public readonly db: Database;
	public readonly originalSql: string;
	public readonly astBatch: ASTStatement[];
	private astBatchIndex: number = -1;
	private finalized = false;
	private busy = false;
	private boundArgs: Record<number | string, SqlValue> = {};
	private plan: BlockNode | null = null;
	private emissionContext: EmissionContext | null = null;
	/**
	 * Cached scheduler for the emitted instruction tree. Emit + schedule are
	 * value-independent (emitters see only `(plan, EmissionContext)`, never bound
	 * params), so this is built once and reused across executions. Its lifetime is
	 * exactly the emission context's: nulled in lockstep with `this.emissionContext`
	 * at every invalidation site, and rebuilt lazily in `_iterateRowsRawInternal`.
	 */
	private scheduler: Scheduler | null = null;
	private needsCompile = true;
	private columnDefCache = new Cached<DeepReadonly<ColumnDef>[]>(() => this.getColumnDefs());
	private schemaChangeUnsubscriber: (() => void) | null = null;
	/** Parameter types established at prepare time (either explicit or inferred from initial values) */
	private parameterTypes: Map<string | number, ScalarType> | undefined = undefined;
	/**
	 * Parameter names/indices used directly as a comparand in a scalar comparison
	 * (`= <> < <= > >=` / `IN` / `BETWEEN`) against a non-object scalar operand.
	 * Binding any of these to a JS array / plain object can never match, so it is
	 * rejected at bind time in {@link validateParameterTypes}. Recomputed on each
	 * (re)compilation from the logical plan; see `analysis/scalar-param-usage.ts`.
	 */
	private scalarRequiredParams: Set<string | number> = new Set();
	/** Debug options set via Database.prepareDebug(). @internal */
	_debugOptions?: import('../planner/planning-context.js').DebugOptions;
	/**
	 * @internal Schema-path override applied when this statement plans (compile is
	 * deferred, so setting this right after `db.prepare(...)` is race-free). Used by
	 * the stored-body seams (materialized-view body re-plans) so an unqualified name
	 * in the body resolves against the owning object's home schema, not the session
	 * path — see {@link Database._homeSchemaPath}.
	 */
	_schemaPathOverride?: string[];

	/**
	 * @internal - Use db.prepare().
	 * The `sqlOrAstBatch` can be a single SQL string (parsed internally) or a pre-parsed batch.
	 * `initialAstIndex` is for internal use when db.prepare might create one Statement per AST in a batch.
	 * `paramsOrTypes` can be initial parameter values (to infer types) or explicit types.
	 */
	constructor(
		db: Database,
		sqlOrAstBatch: string | ASTStatement[],
		initialAstIndex: number = 0,
		paramsOrTypes?: SqlParameters | SqlValue[] | Map<string | number, ScalarType>
	) {
		this.db = db;
		if (typeof sqlOrAstBatch === 'string') {
			this.originalSql = sqlOrAstBatch;
			const parser = new Parser();
			this.astBatch = parser.parseAll(this.originalSql);
		} else {
			this.astBatch = sqlOrAstBatch;
			// Try to reconstruct originalSql if possible, or set a generic name
			this.originalSql = this.astBatch.map(s => astToString(s)).join('; ');
		}

		// Handle explicit parameter types or initial values
		if (paramsOrTypes instanceof Map) {
			// Explicit parameter types provided
			this.parameterTypes = paramsOrTypes;
		} else if (paramsOrTypes !== undefined) {
			// Initial parameter values - infer types and bind them
			this.parameterTypes = getParameterTypes(paramsOrTypes);
			// Also bind the initial values. Values canonicalize as they enter boundArgs
			// (a safe-range bigint narrows to number, R1 — util/numeric-canonical.ts):
			// per-bind, not per-row, and shared by all three ingress sites (here,
			// bind, bindAll). Type inference above saw the raw values, but it maps a
			// safe-range bigint and its number form to INTEGER alike, so no drift.
			if (Array.isArray(paramsOrTypes)) {
				paramsOrTypes.forEach((value, index) => {
					this.boundArgs[index + 1] = canonicalizeSqlValue(value);
				});
			} else {
				for (const [key, value] of Object.entries(paramsOrTypes)) {
					this.boundArgs[key] = canonicalizeSqlValue(value);
				}
			}
		}

		if (this.astBatch.length === 0 && initialAstIndex === 0) {
			// No statements to run, effectively. nextStatement will return false.
			this.astBatchIndex = -1;
			this.needsCompile = false;
		} else if (initialAstIndex >= 0 && initialAstIndex < this.astBatch.length) {
			this.astBatchIndex = initialAstIndex;
			this.needsCompile = true; // Start by needing to compile the first indicated statement
		} else {
			throw new MisuseError("Initial AST index out of bounds for provided batch.");
		}
	}

	/** Advances to the next statement in the batch. Returns false if no more statements. */
	public nextStatement(): boolean {
		this.validateStatement("advance from");
		if (this.busy) throw new MisuseError("Statement busy, reset or complete current iteration first.");
		if (this.astBatchIndex < this.astBatch.length - 1) {
			this.astBatchIndex++;
			this.plan = null;
			this.emissionContext = null;
			this.scheduler = null;
			this.needsCompile = true;
			this.columnDefCache.clear();
			this.parameterTypes = undefined;
			return true;
		} else {
			return false;
		}
	}

	/** Returns the SQL fragment for the current statement, if available. */
	public getBlockSql(): string {
		if (this.astBatchIndex < 0 || this.astBatchIndex >= this.astBatch.length) {
			return "";
		}
		return astToString(this.getAstStatement());
	}

	/** @internal Plans the current AST statement */
	public compile(): BlockNode {
		if (this.plan && !this.needsCompile) return this.plan;

		this.validateStatement("compile/plan");
		this.columnDefCache.clear();

		log("Planning current statement (new runtime): %s", this.getBlockSql().substring(0, 100));
		let plan: BlockNode | undefined;
		try {
			const currentAst = this.getAstStatement();

			// On first compilation, establish the parameter types
			// Use explicit types if provided, otherwise infer from bound args
			if (this.parameterTypes === undefined) {
				// Infer types from current bound args
				this.parameterTypes = getParameterTypes(this.boundArgs);
			}

			// Pass parameter types directly to planning
			const { plan: rawPlan, schemaDependencies: dependencies } = this.db._buildPlan([currentAst], this.parameterTypes, this._schemaPathOverride);
			// Collect array-valued-scalar-param guard targets from the LOGICAL plan,
			// before the access-path optimizer folds `col = ?` comparisons into index
			// seeks (which erases the comparison node). See validateParameterTypes.
			this.scalarRequiredParams = collectScalarRequiredParams(rawPlan);
			plan = this.db.optimizer.optimize(rawPlan, this.db) as BlockNode;

			// Always drop the previous listener before (re)compiling, even when the new
			// plan has no dependencies — otherwise a zero-dependency recompile leaks the
			// old listener on the schema-change notifier.
			if (this.schemaChangeUnsubscriber) {
				this.schemaChangeUnsubscriber();
				this.schemaChangeUnsubscriber = null;
			}

			// Set up schema change invalidation only when we have dependencies
			if (dependencies && dependencies.hasAnyDependencies()) {
				// Add new listener for schema changes that affect our dependencies
				this.schemaChangeUnsubscriber = this.db.schemaManager.getChangeNotifier().addListener(event => {
					// Map event type to the dependency type(s) it can affect
					let dependencyTypes: string[];
					if (event.type === 'view_modified') {
						dependencyTypes = ['view'];
					} else if (event.type === 'materialized_view_added'
						|| event.type === 'materialized_view_removed'
						|| event.type === 'materialized_view_modified') {
						// Unified model: a maintained table IS a table, so plans that read
						// or write it record 'table' dependencies — an attach/detach/
						// re-attach must invalidate them (a cached direct-write plan must
						// not survive an attach, nor a write-through plan a detach).
						// Legacy 'view' dependencies are still honored.
						dependencyTypes = ['table', 'view'];
					} else if (event.type.startsWith('table_')) {
						dependencyTypes = ['table'];
					} else if (event.type.startsWith('function_')) {
						dependencyTypes = ['function'];
					} else if (event.type.startsWith('module_')) {
						dependencyTypes = ['vtab_module'];
					} else if (event.type.startsWith('collation_')) {
						dependencyTypes = ['collation'];
					} else {
						return; // Unknown event type
					}

					// Check if this change affects any of our dependencies
					const planDependencies = dependencies.getDependencies();
					const affectedDependency = planDependencies.find((dep: SchemaDependency) =>
						dependencyTypes.includes(dep.type) &&
						dep.objectName === event.objectName &&
						(!dep.schemaName || dep.schemaName === event.schemaName)
					);

					if (affectedDependency) {
						log('Schema change invalidated plan for statement: %s %s', event.type, event.objectName);
						this.needsCompile = true;
						this.plan = null;
						this.emissionContext = null;
						this.scheduler = null;
						this.columnDefCache.clear();
					}
				});
			}

			this.needsCompile = false;
			log("Planning complete for current statement.");
		} catch (e) {
			errorLog("Planning failed for current statement: %O", e);
			if (e instanceof QuereusError) throw e;
			if (e instanceof Error) throw new QuereusError(`Planning error: ${e.message}`, StatusCode.INTERNAL, e);
			throw new QuereusError("Unknown planning error", StatusCode.INTERNAL);
		}
		if (!plan) throw new QuereusError("Planning resulted in no plan for current statement", StatusCode.INTERNAL);
		this.plan = plan;
		return plan;
	}

	/** @internal Gets or creates the emission context for this statement */
	private getEmissionContext(): EmissionContext {
		if (!this.emissionContext) {
			this.emissionContext = new EmissionContext(this.db);
		}
		return this.emissionContext;
	}

	/**
	 * Binds a user-provided argument value to a declared parameter name/index for the current statement.
	 */
	bind(key: number | string, value: SqlValue): this {
		this.validateStatement("bind argument for");
		if (this.busy) throw new MisuseError("Statement busy, reset first");
		if (!isSqlValue(value)) {
			throw new MisuseError(`bind: invalid value for key '${key}': expected SqlValue, got ${describeSqlValueViolation(value)}`);
		}
		if (typeof key === 'number') {
			if (key < 1) throw new RangeError(`Argument index ${key} out of range (must be >= 1)`);
			this.boundArgs[key] = canonicalizeSqlValue(value);
		} else if (typeof key === 'string') {
			this.boundArgs[key] = canonicalizeSqlValue(value);
		} else {
			throw new MisuseError("Invalid argument key type");
		}
		return this;
	}

	/**
	 * Binds all user-provided argument values for the current statement.
	 */
	bindAll(args: SqlParameters | SqlValue[]): this {
		this.validateStatement("bind all parameters for");
		if (this.busy) throw new MisuseError("Statement busy, reset first");
		this.boundArgs = {};
		if (Array.isArray(args)) {
			// Convert array to object with 1-based numeric keys to match bind() and constructor
			args.forEach((value, index) => {
				if (!isSqlValue(value)) {
					throw new MisuseError(`bindAll: invalid value at index ${index}: expected SqlValue, got ${describeSqlValueViolation(value)}`);
				}
				this.boundArgs[index + 1] = canonicalizeSqlValue(value);
			});
		} else if (typeof args === 'object' && args !== null) {
			// Validate every entry before assigning any, so a rejected value leaves
			// boundArgs empty rather than partially bound.
			for (const [key, value] of Object.entries(args)) {
				if (!isSqlValue(value)) {
					throw new MisuseError(`bindAll: invalid value for key '${key}': expected SqlValue, got ${describeSqlValueViolation(value)}`);
				}
			}
			for (const [key, value] of Object.entries(args)) {
				this.boundArgs[key] = canonicalizeSqlValue(value);
			}
		} else {
			throw new MisuseError("Invalid parameters type for bindAll. Use array or object.");
		}
		return this;
	}

	/** Checks if the current statement, when executed, is expected to produce rows. */
	public isQuery(): boolean {
		this.validateStatement("check if query");
		const blockPlan = this.compile();
		if (!blockPlan || blockPlan.statements.length === 0) return false;
		const lastStatementInBlock = blockPlan.statements[blockPlan.statements.length - 1];
		const relationType = lastStatementInBlock.getType();
		return isRelationType(relationType);
	}

	/**
	 * Low-level row iteration. Does NOT handle transactions - caller must manage.
	 * @internal
	 */
	private async *_iterateRowsRawInternal(
		params?: SqlParameters | SqlValue[],
		runtimeOverrides?: {
			tracer?: InstructionTracer;
			enableMetrics?: boolean;
			signal?: AbortSignal;
			/** Mutex-free committed read — see {@link RuntimeContext.readCommitted}. */
			readCommitted?: boolean;
		}
	): AsyncIterable<Row> {
		this.validateStatement("iterate rows for");
		if (this.busy) throw new MisuseError("Statement busy, another iteration may be in progress or reset needed.");

		// Pre-flight cancellation: reject immediately on an already-aborted signal.
		throwIfAborted(runtimeOverrides?.signal);

		if (params) this.bindAll(params);

		// Validate parameter types before execution
		this.validateParameterTypes();

		this.busy = true;
		// Per-execution cache of connected inner-scan vtab instances (see
		// runtime/emit/scan.ts). Declared out here so the teardown `finally` can
		// disconnect every instance exactly once on all exit paths (normal completion,
		// break, error, abort). `runtimeCtx` is likewise hoisted so `finally` can reach
		// it after the try body assigns it.
		const scanConnections = new Map<symbol, VirtualTable>();
		let runtimeCtx: RuntimeContext | undefined;
		try {
			const blockPlanNode = this.compile();
			if (!blockPlanNode.statements.length) return;

			const emissionContext = this.getEmissionContext();
			// Emit + schedule once and reuse across executions — the instruction tree is
			// value-independent (bound params resolve from ctx.params at run time, not at
			// emit time), and its validity is exactly the emission context's, which is
			// nulled together with `this.scheduler` on any schema-dependency change.
			// NOTE: the emission context (and thus this scheduler) is cached, so toggling
			// the `trace_plan_stack` db option mid-life is ignored until the plan is
			// recompiled — the tracing wrap is baked at emit time. Pre-existing behavior,
			// unchanged here; caching the scheduler does not regress it (per-run tracer
			// wrapping lives in the scheduler hooks, not baked). Recompile to pick up a toggle.
			if (!this.scheduler) {
				const rootInstruction = emitPlanNode(blockPlanNode, emissionContext);
				this.scheduler = new Scheduler(rootInstruction);
			}
			const scheduler = this.scheduler;
			const tracer = runtimeOverrides?.tracer ?? this.db.getInstructionTracer();
			const enableMetrics = runtimeOverrides?.enableMetrics ?? Boolean(this.db.getOption('runtime_metrics'));
			const signal = runtimeOverrides?.signal;
			runtimeCtx = {
				db: this.db,
				stmt: this,
				params: this.boundArgs,
				context: createStrictRowContextMap(),
				tableContexts: wrapTableContextsStrict(new Map()),
				tracer,
				enableMetrics,
				signal,
				scanConnections,
				readCommitted: runtimeOverrides?.readCommitted,
			};

			// Validate captured schema objects once per execution — hoisted out of every
			// capturing instruction's run (see createValidatedInstruction). Runs after any
			// schema-change listener would have fired; a defensive existence check for a
			// schema change racing execution setup. Skip when nothing was captured.
			if (emissionContext.getCapturedObjectCount() > 0) {
				emissionContext.validateCapturedSchemaObjects();
			}

			const results = await scheduler.run(runtimeCtx);
			if (results) {
				if (Array.isArray(results) && results.length) {
					const lastStatementOutput = results[results.length - 1];
					if (isAsyncIterable(lastStatementOutput)) {
						yield* this._iterateWithSignal(lastStatementOutput as AsyncIterable<Row>, signal);
					}
				} else if (isAsyncIterable(results)) {
					yield* this._iterateWithSignal(results as AsyncIterable<Row>, signal);
				}
			}
		} catch (e) {
			errorLog('Runtime execution failed in iterateRows for current statement: %O', e);
			if (e instanceof QuereusError) throw e;
			const message = e instanceof Error ? e.message : String(e);
			throw new QuereusError(`Execution error: ${message}`, StatusCode.ERROR, e instanceof Error ? e : undefined);
		} finally {
			// Disconnect every inner-scan instance connected during this execution,
			// exactly once. This `finally` runs after the consumer finishes draining
			// (normal completion, `break`, error, or abort — the async generator's
			// teardown), so the cached instances stay live for the whole streaming
			// window and are released here. `runtimeCtx` is undefined only on the
			// no-statements early return, where the map is empty anyway.
			if (runtimeCtx) {
				for (const vtab of scanConnections.values()) {
					await disconnectVTable(runtimeCtx, vtab);
				}
			}
			scanConnections.clear();
			this.busy = false;
		}
	}

	/**
	 * Re-yields a row stream while honoring a cancellation signal at every row
	 * boundary. Covers output stages with no underlying table scan (e.g. `values`,
	 * recursive CTEs) that the scan-leaf checkpoint cannot reach.
	 * @internal
	 */
	private async *_iterateWithSignal(source: AsyncIterable<Row>, signal?: AbortSignal): AsyncIterable<Row> {
		if (!signal) {
			yield* source;
			return;
		}
		for await (const row of source) {
			throwIfAborted(signal);
			yield row;
		}
	}

	/** @internal Low-level row iteration without overrides. */
	async *_iterateRowsRaw(params?: SqlParameters | SqlValue[], signal?: AbortSignal): AsyncIterable<Row> {
		yield* this._iterateRowsRawInternal(params, { signal });
	}

	/**
	 * @internal True when this execution should take the mutex-free committed-read
	 * path: the caller opted in (`readConcurrency: 'committed'`) and the compiled
	 * block passes {@link Database._isConcurrentReadEligible}. Compiles early
	 * (synchronously) — the serialized path is untouched and still compiles
	 * lazily inside the mutex when this returns false. Never throws: an
	 * ineligible or uncompilable statement falls back to the serialized path,
	 * where a compile error re-surfaces identically (compile failures are not
	 * memoized).
	 */
	private tryRouteConcurrent(options?: StatementOptions): boolean {
		if (options?.readConcurrency !== 'committed') return false;
		try {
			return this.db._isConcurrentReadEligible(this.compile());
		} catch (e) {
			log('committed-read routing declined (compile failed): %O', e);
			return false;
		}
	}

	/**
	 * @internal Mutex-free committed-read execution. Runs WITHOUT the exec mutex
	 * and MUST NOT touch the implicit-transaction lifecycle
	 * (`_finalizeImplicitTransaction` / `_ensureTransaction` / autocommit
	 * helpers) — any open implicit transaction belongs to the writer running
	 * alongside, and finalizing it here would commit or roll back the WRITER's
	 * transaction. Every table scan connects with `_readCommitted: true` (see
	 * `RuntimeContext.readCommitted`), serving the last committed state.
	 *
	 * The {@link ConcurrentReadScope} is acquired lazily at first pull (not at
	 * routing time) so an iterator that is never consumed holds no scope —
	 * `Database.close()` awaits every live scope's teardown. The scope's signal
	 * (fired by `close()`) is combined with the caller's; `scope.end()` runs in
	 * this generator's `finally`, i.e. on every exit path.
	 */
	async *_iterateConcurrent(params?: SqlParameters | SqlValue[], options?: StatementOptions): AsyncGenerator<Row> {
		throwIfAborted(options?.signal);
		const scope = this.db._beginConcurrentRead();
		const combined = combineAbortSignals(options?.signal, scope.signal);
		try {
			yield* this._iterateRowsRawInternal(params, { signal: combined.signal, readCommitted: true });
		} finally {
			combined.dispose();
			scope.end();
		}
	}

	/**
	 * Iterates over result rows. Handles JIT transaction management - commits
	 * implicit transactions on successful completion, rolls back on error.
	 *
	 * @param options Optional execution options (e.g. an `AbortSignal` for
	 *   cooperative cancellation — checked on the first pull and at every row
	 *   boundary so iteration can be interrupted on a request timeout).
	 */
	iterateRows(params?: SqlParameters | SqlValue[], options?: StatementOptions): AsyncIterableIterator<Row> {
		if (this.tryRouteConcurrent(options)) {
			// Mutex-free committed read: no transaction to finalize here — the
			// writer owns any open implicit transaction (see _iterateConcurrent).
			return this._iterateConcurrent(params, options);
		}
		return wrapAsyncIterator(this._iterateRowsGenerator(params, options?.signal), (commit, error) =>
			this.db._finalizeImplicitTransaction(commit, error)
		);
	}

	/**
	 * Internal generator for iterateRows() that holds the exec mutex for the whole
	 * iteration, so two public iterations over the same db can't interleave the
	 * implicit-transaction lifecycle. Mirrors {@link _allGenerator}, but yields raw
	 * `Row` (no `rowToObject`). Transaction finalization is handled by the wrapper
	 * returned by iterateRows().
	 *
	 * NOTE: on normal completion wrapAsyncIterator runs the transaction-finalize
	 * cleanup after this generator's finally (mutex release), so the implicit-txn
	 * commit lands just outside the mutex — same ordering as all()/`_allGenerator`.
	 * @internal
	 */
	private async *_iterateRowsGenerator(params?: SqlParameters | SqlValue[], signal?: AbortSignal): AsyncGenerator<Row> {
		// Pre-flight cancellation before acquiring the mutex, mirroring _allGenerator/eval().
		throwIfAborted(signal);
		const releaseMutex = await this.db._acquireExecMutex();

		try {
			yield* this._iterateRowsRaw(params, signal);
		} finally {
			releaseMutex();
		}
	}

	/**
	 * Iterates over result rows while forcing instruction tracing for this execution.
	 * Metrics are disabled for trace runs to ensure the tracing scheduler mode is used.
	 */
	iterateRowsWithTrace(params: SqlParameters | SqlValue[] | undefined, tracer: InstructionTracer): AsyncIterableIterator<Row> {
		return wrapAsyncIterator(
			this._iterateRowsRawInternal(params, { tracer, enableMetrics: false }),
			(commit, error) => this.db._finalizeImplicitTransaction(commit, error)
		);
	}

	getColumnNames(): string[] {
		this.validateStatement("get column names for");
		return this.columnDefCache.value.map(col => col.name);
	}

	/**
	 * Resets the prepared statement to its initial state, ready to be re-executed.
	 */
	async reset(): Promise<void> {
		this.validateStatement("reset");
		// Refuse while an iteration is in flight, matching bind/bindAll/clearBindings/
		// nextStatement. Clearing `busy` here would let a second iteration slip past the
		// guard in _iterateRowsRawInternal → two concurrent iterations over one statement.
		// finalize() remains the escape hatch that force-clears `busy`.
		if (this.busy) throw new MisuseError("Statement busy, cannot reset an in-flight iteration; complete or finalize it first.");
	}

	/**
	 * Clears all bound parameter values.
	 * Note: This does NOT trigger recompilation - parameter types are preserved.
	 */
	clearBindings(): this {
		this.validateStatement("clear bindings for");
		if (this.busy) throw new MisuseError("Statement busy, reset first");
		this.boundArgs = {};
		// Don't set needsCompile - parameter types are preserved
		return this;
	}

	/**
	 * Finalizes the statement, releasing associated resources.
	 */
	async finalize(): Promise<void> {
		if (this.finalized) return;
		this.finalized = true;
		this.busy = false;
		this.boundArgs = {};
		this.plan = null;
		this.emissionContext = null;
		this.scheduler = null;
		this.columnDefCache.clear();
		this.astBatchIndex = -1;

		// Clean up schema change listener
		if (this.schemaChangeUnsubscriber) {
			this.schemaChangeUnsubscriber();
			this.schemaChangeUnsubscriber = null;
		}

		this.db._statementFinalized(this);
	}

	/**
	 * Executes the prepared statement with the given parameters until completion.
	 * Transactions are started lazily (just-in-time) when the first DML or DDL
	 * operation occurs. Implicit transactions are committed after execution.
	 *
	 * The execution is serialized through the database mutex to prevent concurrent
	 * transactions from interfering with each other.
	 *
	 * @param options Optional execution options (e.g. an `AbortSignal` for
	 *   cooperative cancellation — checked before acquiring the mutex and at
	 *   execution boundaries during the run).
	 */
	async run(params?: SqlParameters | SqlValue[], options?: StatementOptions): Promise<void> {
		this.validateStatement("run");
		// Pre-flight cancellation: reject before acquiring the mutex / doing work.
		throwIfAborted(options?.signal);

		if (this.tryRouteConcurrent(options)) {
			// Mutex-free committed read (eligibility guarantees read-only): drain
			// without touching the implicit-transaction lifecycle.
			for await (const _ of this._iterateConcurrent(params, options)) {
				/* Consume all rows */
			}
			return;
		}

		await this.db._runWithMutex(async () => {
			let success = false;
			let runError: unknown;
			try {
				for await (const _ of this._iterateRowsRaw(params, options?.signal)) {
					/* Consume all rows */
				}
				success = true;
			} catch (e) {
				runError = e;
				throw e;
			} finally {
				await this.db._finalizeImplicitTransaction(success, runError);
			}
		});
	}

	/**
	 * Executes the prepared statement, binds parameters, and retrieves the first result row.
	 * Transactions are started lazily (just-in-time) when needed.
	 *
	 * @param options Optional execution options (e.g. an `AbortSignal` for
	 *   cooperative cancellation — checked before acquiring the mutex and at the
	 *   row boundary while the first row is produced).
	 */
	async get(params?: SqlParameters | SqlValue[], options?: StatementOptions): Promise<Record<string, SqlValue> | undefined> {
		this.validateStatement("get first row for");
		// Pre-flight cancellation: reject before acquiring the mutex / doing work.
		throwIfAborted(options?.signal);

		if (this.tryRouteConcurrent(options)) {
			const names = this.getColumnNames();
			// The early return triggers the generator's return() → its finally, so
			// scan connections disconnect and the read scope ends.
			for await (const row of this._iterateConcurrent(params, options)) {
				return rowToObject(row, names);
			}
			return undefined;
		}

		return this.db._runWithMutex(async () => {
			let result: Record<string, SqlValue> | undefined;
			let success = false;
			let getError: unknown;

			try {
				const names = this.getColumnNames();
				for await (const row of this._iterateRowsRaw(params, options?.signal)) {
					result = rowToObject(row, names);
					break; // Only need the first row
				}
				success = true;
				return result;
			} catch (e) {
				getError = e;
				throw e;
			} finally {
				await this.db._finalizeImplicitTransaction(success, getError);
			}
		});
	}

	/**
	 * Executes the prepared statement, binds parameters, and retrieves all result rows.
	 * Transactions are started lazily (just-in-time) when needed.
	 * The mutex is held for the entire iteration.
	 *
	 * @param options Optional execution options (e.g. an `AbortSignal` for
	 *   cooperative cancellation — checked before acquiring the mutex and at every
	 *   row boundary so streaming can be interrupted on a request timeout).
	 */
	all(params?: SqlParameters | SqlValue[], options?: StatementOptions): AsyncIterableIterator<Record<string, SqlValue>> {
		this.validateStatement("get all rows for");

		if (this.tryRouteConcurrent(options)) {
			return this._allConcurrentGenerator(params, options);
		}

		return wrapAsyncIterator(this._allGenerator(params, options?.signal), (commit, error) =>
			this.db._finalizeImplicitTransaction(commit, error)
		);
	}

	/**
	 * @internal Committed-read counterpart of {@link _allGenerator}: maps the
	 * mutex-free row stream to objects. No transaction finalization — see
	 * {@link _iterateConcurrent}.
	 */
	private async *_allConcurrentGenerator(params?: SqlParameters | SqlValue[], options?: StatementOptions): AsyncGenerator<Record<string, SqlValue>> {
		const names = this.getColumnNames();
		for await (const row of this._iterateConcurrent(params, options)) {
			yield rowToObject(row, names);
		}
	}

	/**
	 * Internal generator for all() that holds the mutex.
	 * Transaction finalization is handled by the wrapper returned by all().
	 * @internal
	 */
	private async *_allGenerator(params?: SqlParameters | SqlValue[], signal?: AbortSignal): AsyncGenerator<Record<string, SqlValue>> {
		// Pre-flight cancellation before acquiring the mutex, mirroring eval().
		throwIfAborted(signal);
		const releaseMutex = await this.db._acquireExecMutex();

		try {
			const names = this.getColumnNames();
			for await (const row of this._iterateRowsRaw(params, signal)) {
				yield rowToObject(row, names);
			}
		} finally {
			releaseMutex();
		}
	}

	/**
	 * Gets the parameters required by the current statement.
	 */
	getParameters(): SqlParameters {
		this.validateStatement("get parameters for");
		const blockPlan = this.compile();
		return { ...blockPlan.parameters };
	}

	/**
	 * Gets the data type of a column in the current row.
	 */
	getColumnType(index: number): Readonly<ScalarType> {
		this.validateStatement("get column type for");
		const columnDefs = this.columnDefCache.value;
		if (index < 0 || index >= columnDefs.length) {
			throw new RangeError(`Column index ${index} out of range.`);
		}
		return columnDefs[index].type;
	}

	/**
	 * Gets the name of a column by its index.
	 */
	getColumnName(index: number): string {
		this.validateStatement("get column name for");
		const names = this.getColumnNames();
		if (index < 0 || index >= names.length) {
			throw new RangeError(`Column index ${index} out of range (0-${names.length - 1})`);
		}
		return names[index];
	}

	getColumnDefs(): DeepReadonly<ColumnDef>[] {
		if (!this.plan) {
			if (this.astBatchIndex >= 0 && this.astBatchIndex < this.astBatch.length && this.needsCompile) {
				try { this.compile(); } catch { /*ignore compile error for _getColumnDefs, return empty */ }
			}
			if (!this.plan) return [];
		}
		const lastStatementPlanInBlock = this.plan.statements[this.plan.statements.length - 1];
		if (lastStatementPlanInBlock) {
			const relationType = lastStatementPlanInBlock.getType();
			if (isRelationType(relationType) && relationType.columns) {
				return [...relationType.columns];
			}
		}
		return [];
	}

	private validateStatement(operation: string): void {
		if (this.finalized) throw new MisuseError("Statement finalized");
		if (this.astBatchIndex < 0 || this.astBatchIndex >= this.astBatch.length) {
			throw new MisuseError(`No current statement selected to ${operation}. Call nextStatement() first or ensure SQL was not empty.`);
		}
	}

	private getAstStatement(): ASTStatement {
		this.validateStatement("get AST for");
		return this.astBatch[this.astBatchIndex];
	}

	/**
	 * Validates that bound parameters match the expected types from compilation.
	 * Validates that the JavaScript value is compatible with the physical type of the declared logical type.
	 * @throws QuereusError if parameter types don't match
	 */
	private validateParameterTypes(): void {
		// Ensure the plan is compiled so `scalarRequiredParams` reflects the current
		// statement (compile() is memoized — cheap when already planned).
		this.compile();

		// Reject an array/object value bound to a parameter that is used as a scalar
		// comparand (`= <> < <= > >=` / `IN` / `BETWEEN` against a scalar operand).
		// Such a binding can never match — the OBJECT storage class sorts above every
		// scalar — so we diagnose it here at bind time rather than letting the query
		// silently return no rows. The set is collected structurally at plan time
		// (JSON-vs-JSON comparisons are excluded), so this never over-fires.
		for (const key of this.scalarRequiredParams) {
			// Presence check, not `??`: a parameter legitimately bound to `null` must
			// use that binding, not fall through to the `:`-prefixed alternate key.
			const value = typeof key === 'string'
				? (Object.hasOwn(this.boundArgs, key) ? this.boundArgs[key] : this.boundArgs[`:${key}`])
				: this.boundArgs[key];
			if (value !== undefined && isObjectClassValue(value)) {
				throw new QuereusError(
					`parameter ${typeof key === 'number' ? `?${key}` : `:${key}`} ` +
					`bound to an array/object value but used in a scalar comparison`,
					StatusCode.MISMATCH
				);
			}
		}

		if (!this.parameterTypes) return; // No parameter types established yet

		for (const [key, expectedType] of this.parameterTypes.entries()) {
			const value = this.boundArgs[key];

			// Allow undefined/missing parameters (they'll be caught at runtime if required)
			if (value === undefined) continue;

			// NULL is compatible with any nullable type
			if (value === null) {
				if (!expectedType.nullable) {
					throw new QuereusError(
						`Parameter type mismatch for ${typeof key === 'number' ? `?${key}` : `:${key}`}: ` +
						`expected non-nullable ${expectedType.logicalType.name}, got NULL`,
						StatusCode.MISMATCH
					);
				}
				continue;
			}

			// Get the physical type of the declared logical type
			const expectedPhysicalType = expectedType.logicalType.physicalType;

			// Get the physical type directly from the JavaScript value
			const actualPhysicalType = getPhysicalType(value);

			// Check if physical types are compatible
			// INTEGER is compatible with REAL (any integer is a valid real number)
			const isCompatible =
				actualPhysicalType === expectedPhysicalType ||
				(expectedPhysicalType === PhysicalType.REAL && actualPhysicalType === PhysicalType.INTEGER);

			if (!isCompatible) {
				throw new QuereusError(
					`Parameter type mismatch for ${typeof key === 'number' ? `?${key}` : `:${key}`}: ` +
					`expected ${expectedType.logicalType.name} (physical: ${physicalTypeName(expectedPhysicalType)}), ` +
					`got value with physical type ${physicalTypeName(actualPhysicalType)}`,
					StatusCode.MISMATCH
				);
			}
		}
	}

	/**
	 * Analyzes which base-table state and external inputs the statement may
	 * read from, returning a serializable `ChangeScope`. Bound parameters
	 * provided via `params` (or already bound to the statement) are
	 * substituted into the scope's row-binding placeholders; remaining
	 * placeholders surface under `unboundParameters`.
	 */
	getChangeScope(params?: SqlParameters | SqlValue[]): ChangeScope {
		this.validateStatement("get change scope for");
		const plan = this.getAnalysisPlan();
		const effectiveParams = params ?? (Object.keys(this.boundArgs).length > 0 ? this.boundArgs : undefined);
		const sm = this.db.schemaManager;
		return analyzeChangeScope(plan, {
			...(effectiveParams !== undefined ? { params: effectiveParams } : {}),
			// Project a maintained table's reference onto its cached source-union
			// scope, widening the watch to the sources whose mutations drive its
			// maintenance. (The table itself is change-logged too — maintenance
			// records its realized deltas — so this is granularity, not a
			// prerequisite.) Ordinary tables resolve to `undefined` and keep
			// reporting themselves.
			resolveMaterializedViewSource: (table) =>
				sm.getMaintainedTable(table.schema, table.table)?.derivation.sourceScope,
		});
	}

	/**
	 * @internal Build (or re-build) a pre-physical analysis plan for the
	 * current AST statement. Analysis-only callers (change-scope, future
	 * binding-aware tools) need a plan whose TableReferenceNodes still
	 * sit in plain logical structure, not wrapped by physical access
	 * operators. This path is independent of the execution plan cache.
	 */
	private getAnalysisPlan(): BlockNode {
		const currentAst = this.getAstStatement();
		if (this.parameterTypes === undefined) {
			this.parameterTypes = getParameterTypes(this.boundArgs);
		}
		const { plan: rawPlan } = this.db._buildPlan([currentAst], this.parameterTypes, this._schemaPathOverride);
		return this.db.optimizer.optimizeForAnalysis(rawPlan, this.db) as BlockNode;
	}

	/**
	 * Gets a detailed JSON representation of the query plan for debugging.
	 * @returns JSON string containing the detailed plan tree.
	 */
	getDebugPlan(): string {
		this.validateStatement("get debug plan for");
		const plan = this.compile();
		return serializePlanTree(plan);
	}

	/**
	 * Gets a human-readable instruction program for debugging.
	 * @returns String representation of the instruction program.
	 */
	getDebugProgram(): string {
		this.validateStatement("get debug program for");
		const plan = this.compile();
		const emissionContext = this.getEmissionContext();
		const rootInstruction = emitPlanNode(plan, emissionContext);
		const scheduler = new Scheduler(rootInstruction);

		return generateInstructionProgram(scheduler.instructions, scheduler.destinations);
	}
}

