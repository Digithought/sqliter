/**
 * Global assertion evaluation for deferred constraint checking.
 *
 * This module handles the evaluation of CREATE ASSERTION constraints at
 * transaction commit time. It optimizes assertion checking by:
 * - Only evaluating assertions impacted by changed tables
 * - Caching compiled plans, classifications, and residual variants across commits
 * - Invalidating cached plans on schema changes
 * - Driving per-binding execution through the reusable `DeltaExecutor` kernel
 *
 * Assertions are the first consumer of `DeltaExecutor`. Materialized views,
 * reactive signals, and triggers will plug in by registering their own
 * `DeltaSubscription`s.
 */

import { QuereusError } from '../common/errors.js';
import { StatusCode, type SqlValue } from '../common/types.js';
import { createLogger } from '../common/logger.js';
import { Parser } from '../parser/parser.js';
import * as AST from '../parser/ast.js';
import { emitPlanNode } from '../runtime/emitters.js';
import { Scheduler } from '../runtime/scheduler.js';
import type { RuntimeContext, Instruction } from '../runtime/types.js';
import { createStrictRowContextMap, wrapTableContextsStrict } from '../runtime/strict-fork.js';
import { BlockNode } from '../planner/nodes/block.js';
import { EmissionContext } from '../runtime/emission-context.js';
import { isAsyncIterable } from '../runtime/utils.js';
import { extractBindings, type BindingMode, type PlanBindings } from '../planner/analysis/binding-extractor.js';
import { planAssertionBodyForAnalysis } from '../planner/analysis/assertion-plan.js';
import { injectKeyFilter } from '../planner/analysis/key-filter.js';
import { DeltaExecutor, type DeltaApplyInput, type DeltaExecutorContext, type DeltaSubscription } from '../runtime/delta-executor.js';
import type { Database } from './database.js';
import type { SchemaChangeEvent } from '../schema/change-events.js';
import { splitBaseKey } from '../util/qualified-name.js';
import { catalogRowCount } from '../planner/stats/table-cardinality.js';

const log = createLogger('core:assertions');

/** Maximum number of violating rows to include in error messages */
const MAX_VIOLATION_SAMPLES = 5;

/** The identity slice of {@link IntegrityAssertionSchema} the evaluator needs. */
interface AssertionIdentity {
	name: string;
	schemaName: string;
	violationSql: string;
}

/** Cache key for an assertion: schema-qualified so two same-named assertions
 *  in different schemas never evict each other's compiled plan. */
function assertionCacheKey(assertion: { name: string; schemaName: string }): string {
	return `${assertion.schemaName.toLowerCase()}.${assertion.name.toLowerCase()}`;
}

/** How an assertion names itself in a violation error / report-mode record.
 *  Qualified outside `main`, where a bare name is ambiguous (names are only
 *  unique per schema); bare in `main`, matching the rest of the DDL surface
 *  (see `applyAssertionSchemaDefault`, `assertionSchemaToCatalog`). */
function assertionDisplayName(assertion: { name: string; schemaName: string }): string {
	return assertion.schemaName.toLowerCase() === 'main'
		? assertion.name
		: `${assertion.schemaName}.${assertion.name}`;
}

/**
 * A single commit-time global-assertion violation, collected (rather than
 * thrown) when {@link AssertionEvaluator.runGlobalAssertions} is driven in
 * report mode. Surfaced to the external-row ingestion seam's caller so a
 * trust-the-origin inbound merge can land its data and still be notified of
 * the broken invariant. See `docs/mv-ingestion.md` § Trust boundary.
 */
export interface AssertionViolation {
	/** Name of the violated assertion. */
	readonly assertion: string;
	/** Up to {@link MAX_VIOLATION_SAMPLES} sample rows. For a full-violation
	 *  query these are the query's output rows; for per-tuple residual dispatch
	 *  the single binding-key tuple. Diagnostic only — the assertion SELECT's
	 *  output shape, not full table rows. */
	readonly samples: SqlValue[][];
}

/**
 * Interface for accessing Database internals needed by the assertion evaluator.
 * This decouples the evaluator from the full Database class.
 */
export interface AssertionEvaluatorContext {
	readonly schemaManager: Database['schemaManager'];
	readonly optimizer: Database['optimizer'];
	readonly options: Database['options'];

	_buildPlan(statements: AST.Statement[], paramsOrTypes?: undefined, schemaPathOverride?: string[]): import('./database.js').BuildPlanResult;
	_findTable(tableName: string, schemaName?: string): ReturnType<Database['_findTable']>;
	_homeSchemaPath(schemaName: string): string[];
	prepare(sql: string): ReturnType<Database['prepare']>;
	getInstructionTracer(): ReturnType<Database['getInstructionTracer']>;

	/** Get the set of changed base tables (lowercase qualified names) */
	getChangedBaseTables(): Set<string>;
	/** Get changed PK tuples for a specific base table */
	getChangedKeyTuples(base: string): SqlValue[][];
	/** Get changed projected tuples for a specific base table */
	getChangedTuples(base: string, columnIndices: readonly number[], pkIndices: readonly number[]): SqlValue[][];
	/** Register a column-projection capture spec for a base table */
	registerCaptureSpec(baseTable: string, spec: { extraColumns: ReadonlySet<number> }): () => void;
}

/**
 * Per-relation residual artifacts for a single assertion. Each entry
 * corresponds to a parameterizable binding (`'row'` or `'group'`) on one
 * `TableReferenceNode` instance.
 */
interface ResidualArtifacts {
	instruction: Instruction;
	scheduler: Scheduler;
	/** Column indices in the table's column space; map directly to bind params
	 *  named `pk0..pkN-1` (for 'row') or `gk0..gkN-1` (for 'group'). */
	bindColumns: number[];
	/** Parameter name prefix used when binding tuples: 'pk' or 'gk'. */
	paramPrefix: 'pk' | 'gk';
}

/**
 * Cached compilation artifacts for an assertion, avoiding re-parse/re-plan/re-optimize on every commit.
 */
interface CachedAssertionPlan {
	/** Optimized-for-analysis plan (pre-physical, used for classification and key filter injection) */
	analyzedPlan: BlockNode;
	/** Binding info extracted from the analyzed plan */
	bindings: PlanBindings;
	/** Set of base table names referenced in the plan */
	baseTablesInPlan: Set<string>;
	/** PK indices per base table (derived from schema) */
	pkIndicesByBase: Map<string, number[]>;
	/** Per-relationKey residual artifacts for 'row' and 'group' bindings */
	residualsByRelation: Map<string, ResidualArtifacts>;
	/** Dispose handles for projection-capture specs registered with the
	 *  TransactionManager. Released on `invalidateAssertion`/`dispose`. */
	captureDisposers: Array<() => void>;
	/** Schema generation counter at cache time */
	schemaGeneration: number;
	/** DeltaSubscription dispose handle; released on invalidation/dispose. */
	subscriptionDisposer: () => void;
}

/**
 * Evaluates global assertions (CREATE ASSERTION) at transaction commit time.
 *
 * Assertions are evaluated only when the tables they reference have been modified.
 * The evaluator uses binding analysis to determine whether assertions can be
 * checked per-row, per-group, or require a full violation query.
 *
 * Compiled plans and residual variants are cached and invalidated on schema
 * changes to avoid re-parsing/re-planning on every commit.
 */
export class AssertionEvaluator {
	/** Cached compiled plans keyed by lowercase `schema.name` (see {@link assertionCacheKey}) */
	private cache = new Map<string, CachedAssertionPlan>();
	/** Monotonic generation counter; incremented on schema changes that may affect assertions */
	private schemaGeneration = 0;
	/** Unsubscribe function for schema change listener */
	private unsubscribeSchemaChanges: (() => void) | null = null;
	/** The shared delta dispatcher */
	private readonly executor: DeltaExecutor;
	/** Transient violation sink for a single `runGlobalAssertions` pass. When
	 *  non-null (report mode), violations are pushed here and execution
	 *  continues; when null (default) violations throw. Set/restored by
	 *  `runGlobalAssertions`. */
	private violationSink: AssertionViolation[] | null = null;

	constructor(private readonly ctx: AssertionEvaluatorContext) {
		const executorCtx: DeltaExecutorContext = {
			getChangedBaseTables: () => ctx.getChangedBaseTables(),
			getChangedTuples: (base, cols, pk) => ctx.getChangedTuples(base, cols, pk),
			getRowCount: (base) => {
				const [schemaName, tableName] = splitBaseKey(base);
				const table = ctx._findTable(tableName, schemaName);
				return table ? catalogRowCount(table) : undefined;
			},
			deltaPerRowFallbackRatio: ctx.optimizer.tuning.deltaPerRowFallbackRatio,
		};
		this.executor = new DeltaExecutor(executorCtx);
		this.subscribeToSchemaChanges();
	}

	// NOTE: `assertion_modified` deliberately does NOT bump the generation — the only
	// producer today is the `ALTER TABLE … RENAME` body rewrite
	// (`runtime/emit/assertion-rename-helpers.ts`), and that statement already fires
	// `table_modified` for the renamed table before it rewrites any body, so the
	// cached plan is invalidated either way. `CREATE ASSERTION` over an existing name
	// is refused, so no in-place redefine reaches here. If a redefine path is ever
	// added (`create or replace assertion`, a catalog-import reconstruction), add
	// `assertion_modified` to this gate — without it the evaluator keeps serving a
	// plan compiled from the previous `violationSql`.
	private subscribeToSchemaChanges(): void {
		const notifier = this.ctx.schemaManager.getChangeNotifier();
		this.unsubscribeSchemaChanges = notifier.addListener((event: SchemaChangeEvent) => {
			if (event.type === 'table_added' || event.type === 'table_removed' || event.type === 'table_modified') {
				this.schemaGeneration++;
				log('Schema generation bumped to %d due to %s on %s', this.schemaGeneration, event.type, event.objectName);
			}
		});
	}

	/** Remove an assertion from the plan cache (called on DROP ASSERTION) */
	invalidateAssertion(schemaName: string, name: string): void {
		const key = assertionCacheKey({ name, schemaName });
		const cached = this.cache.get(key);
		if (cached) {
			this.releaseCached(cached);
			this.cache.delete(key);
		}
	}

	/** Unsubscribe from schema changes and clear cached plans */
	dispose(): void {
		if (this.unsubscribeSchemaChanges) {
			this.unsubscribeSchemaChanges();
			this.unsubscribeSchemaChanges = null;
		}
		for (const cached of this.cache.values()) {
			this.releaseCached(cached);
		}
		this.cache.clear();
		this.executor.disposeAll();
	}

	private releaseCached(cached: CachedAssertionPlan): void {
		cached.subscriptionDisposer();
		for (const d of cached.captureDisposers) d();
		cached.captureDisposers.length = 0;
	}

	/**
	 * Run all global assertions impacted by changes in the current transaction.
	 * The DeltaExecutor walks all live subscriptions; assertion subscriptions
	 * dispatch their own residual scheduler per binding tuple.
	 *
	 * In the default (throw) mode the first violation throws a CONSTRAINT
	 * `QuereusError`. When `sink` is supplied (report mode), violations are
	 * **collected** into it and execution continues — so EVERY live assertion is
	 * walked and ALL violations across the batch are gathered, not just the
	 * first. Report mode is used by the external-row ingestion seam so a
	 * trusted inbound merge can land its data and still surface the broken
	 * invariant (see `docs/mv-ingestion.md` § Trust boundary).
	 *
	 * @param sink When provided, collect violations here instead of throwing.
	 * @throws QuereusError with CONSTRAINT status if any assertion is violated
	 *   and no `sink` is supplied.
	 */
	async runGlobalAssertions(sink?: AssertionViolation[]): Promise<void> {
		const assertions = this.ctx.schemaManager.getAllAssertions();
		if (assertions.length === 0) return;

		const changedBases = this.ctx.getChangedBaseTables();
		if (changedBases.size === 0) return;

		// Install the sink for the duration of this pass; restore null after so a
		// subsequent ordinary commit throws as usual (try/finally guards a throw
		// from the no-dependency loop or the kernel walk in throw mode).
		this.violationSink = sink ?? null;
		try {
			// Ensure every assertion is compiled (registers its subscription on
			// first touch). Subsequent commits reuse the cached subscription unless
			// schema has changed.
			for (const assertion of assertions) {
				this.getOrCompilePlan(assertion);
			}

			// Assertions with no table dependencies (e.g. CHECK (1 = 0)) must run on
			// every commit regardless of what changed — the kernel skips them because
			// it dispatches on dependency overlap. Handle them directly here. In
			// report mode these collect (do not throw), so all are evaluated.
			for (const assertion of assertions) {
				const cached = this.cache.get(assertionCacheKey(assertion));
				if (cached && cached.baseTablesInPlan.size === 0) {
					await this.executeViolationOnce(assertion);
				}
			}

			// Kernel walks all live subscriptions. In throw mode the first violation
			// aborts the walk; in report mode every subscription runs and all
			// violations are collected.
			await this.executor.runAll();
		} finally {
			this.violationSink = null;
		}
	}

	private getOrCompilePlan(assertion: AssertionIdentity): CachedAssertionPlan {
		const key = assertionCacheKey(assertion);
		const existing = this.cache.get(key);
		if (existing && existing.schemaGeneration === this.schemaGeneration) {
			return existing;
		}
		if (existing) {
			this.releaseCached(existing);
		}

		log('Compiling assertion plan for %s (generation %d)', assertion.name, this.schemaGeneration);

		const parser = new Parser();
		let ast: AST.Statement;
		try {
			ast = parser.parse(assertion.violationSql) as AST.Statement;
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			throw new QuereusError(
				`Failed to parse deferred assertion '${assertion.name}': ${error.message}`,
				StatusCode.INTERNAL,
				error
			);
		}

		// Suppress optimizer-side assertion-hoisting throughout assertion plan
		// compilation. Otherwise the hoist would let the optimizer fold this
		// assertion's own violation query to empty (the assertion would prove
		// its own non-violation), defeating commit-time enforcement.
		// See `planner/analysis/assertion-hoist-cache.ts`.
		return this.ctx.schemaManager.withSuppressedAssertionHoist(() => this.compileUnderSuppression(assertion, ast, key));
	}

	private compileUnderSuppression(
		assertion: AssertionIdentity,
		ast: AST.Statement,
		key: string,
	): CachedAssertionPlan {
		// Home-schema path, analysis-stage optimization, hoist suppression — the
		// shared recipe, so `CREATE ASSERTION`'s dependency discovery and
		// `explain_assertion()` see exactly the plan enforcement runs against.
		// (The hoist suppression the helper applies nests inside the caller's,
		// which covers the residual compilation below as well.)
		const analyzed = planAssertionBodyForAnalysis(
			this.ctx as unknown as Database, ast, assertion.schemaName) as BlockNode;

		const bindings = extractBindings(analyzed);

		// Collect baseTables and PK indices per base.
		const baseTablesInPlan = new Set<string>();
		const pkIndicesByBase = new Map<string, number[]>();
		for (const base of bindings.relationToBase.values()) {
			baseTablesInPlan.add(base);
			if (!pkIndicesByBase.has(base)) {
				const [schemaName, tableName] = splitBaseKey(base);
				const table = this.ctx._findTable(tableName, schemaName);
				if (table) {
					pkIndicesByBase.set(base, table.primaryKeyDefinition.map(d => d.index));
				}
			}
		}

		// Register projection capture for any binding whose key columns aren't
		// already covered by the table's PK. PK columns are always captured
		// implicitly; 'row' bindings normally bind on PK and need nothing extra,
		// but a 'row' binding picked from a covered non-PK unique key (and any
		// 'group' binding) requires its non-PK columns to be retained on every
		// change.
		const captureDisposers: Array<() => void> = [];
		const extraByBase = new Map<string, Set<number>>();
		const recordExtras = (base: string, cols: readonly number[]): void => {
			const pk = pkIndicesByBase.get(base);
			const pkSet = pk ? new Set<number>(pk) : new Set<number>();
			for (const c of cols) {
				if (pkSet.has(c)) continue;
				let set = extraByBase.get(base);
				if (!set) {
					set = new Set<number>();
					extraByBase.set(base, set);
				}
				set.add(c);
			}
		};
		for (const [relKey, mode] of bindings.perRelation) {
			const base = bindings.relationToBase.get(relKey);
			if (!base) continue;
			if (mode.kind === 'row') {
				recordExtras(base, mode.keyColumns);
			} else if (mode.kind === 'group') {
				recordExtras(base, mode.groupColumns);
			}
		}
		for (const [base, extra] of extraByBase) {
			captureDisposers.push(this.ctx.registerCaptureSpec(base, { extraColumns: extra }));
		}

		// Pre-compile per-relation residuals for 'row' and 'group' bindings.
		const residualsByRelation = new Map<string, ResidualArtifacts>();
		for (const [relKey, mode] of bindings.perRelation) {
			if (mode.kind === 'global') continue;
			const bindCols = mode.kind === 'row' ? mode.keyColumns : mode.groupColumns;
			const paramPrefix: 'pk' | 'gk' = mode.kind === 'row' ? 'pk' : 'gk';
			const rewritten = injectKeyFilter(analyzed, relKey, bindCols, paramPrefix);
			const optimizedPlan = this.ctx.optimizer.optimize(rewritten, this.ctx as unknown as Database) as BlockNode;
			const emissionContext = new EmissionContext(this.ctx as unknown as Database);
			const instruction = emitPlanNode(optimizedPlan, emissionContext);
			const scheduler = new Scheduler(instruction);
			residualsByRelation.set(relKey, {
				instruction,
				scheduler,
				bindColumns: [...bindCols],
				paramPrefix,
			});
		}

		const cached: CachedAssertionPlan = {
			analyzedPlan: analyzed,
			bindings,
			baseTablesInPlan,
			pkIndicesByBase,
			residualsByRelation,
			captureDisposers,
			schemaGeneration: this.schemaGeneration,
			subscriptionDisposer: () => { /* replaced below */ },
		};

		const subscription = this.buildSubscription(assertion, cached);
		cached.subscriptionDisposer = this.executor.register(subscription);

		this.cache.set(key, cached);
		return cached;
	}

	private buildSubscription(
		assertion: AssertionIdentity,
		cached: CachedAssertionPlan,
	): DeltaSubscription {
		const id = `assertion:${assertionCacheKey(assertion)}`;
		const bindingsForExecutor = new Map<string, BindingMode>(cached.bindings.perRelation);
		const relationToBase = new Map<string, string>(cached.bindings.relationToBase);
		const pkIndicesByBase = new Map<string, readonly number[]>(cached.pkIndicesByBase);

		const apply = async (input: DeltaApplyInput): Promise<void> => {
			// Per-binding dispatch for 'row'/'group' relations.
			for (const [relKey, tuples] of input.perRelationTuples) {
				const residual = cached.residualsByRelation.get(relKey);
				if (!residual) {
					// Defensive: no residual compiled — run the full violation
					// query once to maintain correctness.
					await this.executeViolationOnce(assertion);
					return;
				}
				await this.executeResidualPerTuple(assertionDisplayName(assertion), residual, tuples);
			}

			// Global re-evaluation: run once if any relation needs it. (Multiple
			// 'global' relations for one assertion still only need one run.)
			if (input.globalRelations.size > 0) {
				await this.executeViolationOnce(assertion);
			}
		};

		return {
			id,
			dependencies: cached.baseTablesInPlan,
			bindings: bindingsForExecutor,
			relationToBase,
			pkIndicesByBase,
			apply,
			dispose: () => { /* no per-sub resources beyond the cached entry */ },
		};
	}

	private async executeViolationOnce(assertion: AssertionIdentity): Promise<void> {
		const assertionName = assertionDisplayName(assertion);
		// `prepare()` defers planning; force compile under hoist-suppression so
		// the optimizer can't fold this assertion's own violation query to
		// empty. See `getOrCompilePlan`. The home-schema path override makes the
		// stored body resolve unqualified names against the assertion's own
		// schema (compile is deferred, so setting it here is race-free).
		const stmt = this.ctx.prepare(assertion.violationSql);
		stmt._schemaPathOverride = this.ctx._homeSchemaPath(assertion.schemaName);
		this.ctx.schemaManager.withSuppressedAssertionHoist(() => { stmt.compile(); });
		try {
			const violatingRows: SqlValue[][] = [];
			// Use _iterateRowsRaw() to avoid transaction management - we're already inside
			// the commit path and don't want to trigger nested commit/rollback behavior
			for await (const row of stmt._iterateRowsRaw()) {
				violatingRows.push(row as SqlValue[]);
				if (violatingRows.length >= MAX_VIOLATION_SAMPLES) break;
			}
			if (violatingRows.length > 0) {
				this.raiseViolation(assertionName, violatingRows);
			}
		} finally {
			await stmt.finalize();
		}
	}

	private async executeResidualPerTuple(
		assertionName: string,
		artifacts: ResidualArtifacts,
		tuples: readonly SqlValue[][],
	): Promise<void> {
		if (tuples.length === 0) return;

		const { scheduler, paramPrefix } = artifacts;

		for (const tuple of tuples) {
			const params: Record<string, SqlValue> = {};
			for (let i = 0; i < tuple.length; i++) {
				params[`${paramPrefix}${i}`] = tuple[i];
			}

			const runtimeCtx: RuntimeContext = {
				db: this.ctx as unknown as Database,
				stmt: undefined,
				params,
				context: createStrictRowContextMap(),
				tableContexts: wrapTableContextsStrict(new Map()),
				tracer: this.ctx.getInstructionTracer(),
				enableMetrics: this.ctx.options.getBooleanOption('runtime_stats'),
			};

			const result = await scheduler.run(runtimeCtx);
			if (isAsyncIterable(result)) {
				for await (const _ of result as AsyncIterable<unknown>) {
					// First violating tuple for this binding: throw (default) or
					// collect-and-stop (report mode mirrors the throw's method exit).
					this.raiseViolation(assertionName, [tuple as SqlValue[]]);
					return;
				}
			}
		}
	}

	/**
	 * Raise one violation: throw a CONSTRAINT error in the default mode, or push
	 * to {@link violationSink} (report mode) and let the caller continue/return.
	 */
	private raiseViolation(assertionName: string, samples: SqlValue[][]): void {
		if (this.violationSink) {
			this.violationSink.push({ assertion: assertionName, samples });
			return;
		}
		throw this.buildViolationError(assertionName, samples);
	}

	private buildViolationError(assertionName: string, samples: SqlValue[][]): QuereusError {
		let message = `Integrity assertion failed: ${assertionName}`;
		if (samples.length > 0) {
			const formatted = samples.map(row => `(${row.map(v => v === null ? 'NULL' : JSON.stringify(v)).join(', ')})`);
			message += ` [${formatted.join(', ')}]`;
		}
		return new QuereusError(message, StatusCode.CONSTRAINT);
	}
}
