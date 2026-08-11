import type { DmlExecutorNode } from '../../planner/nodes/dml-executor-node.js';
import type { Instruction, RuntimeContext, InstructionRun, OutputValue } from '../types.js';
import { asRun } from '../types.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { QuereusError, ConstraintError, FailConflictError, RollbackConflictError, throwIfAborted } from '../../common/errors.js';
import { StatusCode, type Row, type SqlValue, type SubProgram, isConstraintViolation } from '../../common/types.js';
import { getVTable, disconnectVTable } from '../utils.js';
import { ConflictResolution } from '../../common/constants.js';
import type { EmissionContext } from '../emission-context.js';
import { extractOldRowFromFlat, extractNewRowFromFlat } from '../../util/row-descriptor.js';
import { buildInsertStatement, buildUpdateStatement, buildDeleteStatement } from '../../util/mutation-statement.js';
import type { UpdateArgs, VirtualTable } from '../../vtab/table.js';
import type { TableSchema } from '../../schema/table.js';
import { isMaintainedTable } from '../../schema/derivation.js';
import { hasNativeEventSupport } from '../../util/event-support.js';
import { sqlValueIdentical, compareSqlValuesFast, BINARY_COLLATION } from '../../util/comparison.js';
import { uniqueEnforcementComparators } from '../../schema/unique-enforcement.js';
import { buildCellCoercion } from '../../types/validation.js';
import { withAsyncRowContext } from '../context-helpers.js';
import { REPR_STRICT } from '../strict-flags.js';
import { assertRowConforms } from '../strict-representation.js';
import type { RowDescriptor } from '../../planner/nodes/plan-node.js';
import { executeForeignKeyActionsAndLens, assertTransitiveRestrictsForParentMutation, createParentRestrictBatch, accumulateParentRestrictKeys, flushParentRestrictBatch, type ParentRestrictBatch } from '../foreign-key-actions.js';
import { getBatchableRestrictFks } from '../../planner/building/foreign-key-builder.js';
import { composeCombinedDescriptor } from '../descriptor-helpers.js';
import { RowOpFlag } from '../../schema/table.js';
import {
	buildConstraintMetadata,
	evaluateRowConstraints,
	type ConstraintMetadataEntry,
	type NotNullDefaultRuntime,
	type RowConstraintScope,
} from '../row-constraints.js';
import type { BackingConnectionCache, ResidualKeyBatch } from '../../core/database-materialized-views.js';
import { poisonResidualDeltaAccumulations } from '../../core/database-materialized-views-apply.js';
import type { BackingRowChange } from '../../vtab/backing-host.js';

/**
 * Module-scope counter producing unique statement-savepoint names across
 * concurrent emissions. Names must be unique within the TransactionManager's
 * savepoint stack; per-runInsert counters would collide for nested mutations
 * (e.g. FK cascade during the parent insert).
 */
let stmtSavepointCounter = 0;

/**
 * Runtime UPSERT clause with pre-resolved evaluator callbacks.
 * The callbacks are resolved by the scheduler from the params array.
 */
interface RuntimeUpsertClause {
	conflictTargetIndices?: number[];
	/**
	 * Per-conflict-target-column comparison function, index-aligned with
	 * {@link conflictTargetIndices}. Built once at emit by
	 * {@link uniqueEnforcementComparators} — the same rule every UNIQUE re-validator
	 * uses — so a semantic-ordering column compares by its declared type's `compare`
	 * and every other column by the resolved enforcement collation. An absent array
	 * falls back to BINARY collation compare, i.e. the pre-fix byte-identity behavior.
	 */
	conflictTargetComparators?: Array<(a: SqlValue, b: SqlValue) => number>;
	action: 'nothing' | 'update';
	/** Indices into the evaluators array for each USER assignment (column index -> evaluator index) */
	assignmentIndices?: Map<number, number>;
	/**
	 * The implicit generated-column recomputes, in `generatedColumnTopoOrder`.
	 * Held separately from {@link assignmentIndices} because they run in a SECOND
	 * pass: a generated column derives from the POST-update row, so it cannot be
	 * evaluated in the pass that still has the pre-update existing row bound.
	 */
	generatedAssignments?: Array<{ colIndex: number; evaluatorIndex: number }>;
	/**
	 * Clone of {@link existingRowDescriptor} — same attribute ids, distinct object
	 * identity — used to bind those ids to the composed post-assignment row for the
	 * generated-column pass. Distinct object on purpose: the runtime context map is
	 * keyed by descriptor identity, so binding the same object to a second row would
	 * make the two bindings one entry. The phase-1 binding has already unwound by the
	 * time phase 2 binds, so today they cannot overlap — the separate object is what
	 * keeps that true if either pass is ever nested inside the other. Set only when
	 * {@link generatedAssignments} is non-empty.
	 */
	generatedRowDescriptor?: RowDescriptor;
	/**
	 * How each DO UPDATE assignment value converts to the declared type before it is
	 * written — the same per-cell decision emitUpdate makes, from the shared helper
	 * `buildCellCoercion`. Keyed by column index; a column absent here has provably
	 * nothing to do and is assigned as evaluated.
	 */
	assignmentCoercions?: Map<number, (value: SqlValue) => SqlValue>;
	/** Index into the evaluators array for WHERE condition, or -1 if no WHERE */
	whereIndex: number;
	/** Row descriptor for NEW references */
	newRowDescriptor?: RowDescriptor;
	/** Row descriptor for existing row references */
	existingRowDescriptor?: RowDescriptor;
}

/**
 * True when a proposed value equals the stored existing value at one conflict-target
 * column the way the targeted constraint ENFORCES: through the column's precomputed
 * comparator (declared-type `compare` for a semantic-ordering column, else the
 * enforcement collation). Both sides are already in declared (stored) form —
 * `existing` is a stored row and the proposed row was converted by the INSERT
 * emitter's static-type pass — so no per-row conversion happens here.
 *
 * `targetPos` indexes the clause's per-target comparator array (aligned with
 * `conflictTargetIndices`). When absent — a defensively-old plan — it degrades to
 * BINARY, i.e. the byte-identity semantics of `sqlValueIdentical`, preserving its
 * numeric-storage-class tolerance via {@link compareSqlValuesFast}.
 */
function conflictTargetValuesMatch(
	existing: SqlValue,
	proposed: SqlValue,
	clause: RuntimeUpsertClause,
	targetPos: number,
): boolean {
	const compare = clause.conflictTargetComparators?.[targetPos];
	if (compare) return compare(existing, proposed) === 0;
	return compareSqlValuesFast(existing, proposed, BINARY_COLLATION) === 0;
}

/**
 * Returns true when the table's owning *module* natively emits data events.
 * The gate must consult the MODULE, not the vtab instance: StoreModule exposes
 * getEventEmitter only at the module level — its table instances do not — so an
 * instance check spuriously reports "no native support" and the engine double-emits
 * alongside the module's native emitter. Mirrors the schema-event gate in
 * schema/manager.ts (emitAutoSchemaEventIfNeeded).
 */
function moduleHasNativeDataEvents(ctx: RuntimeContext, tableSchema: TableSchema): boolean {
	const moduleName = tableSchema.vtabModuleName;
	const moduleReg = moduleName ? ctx.db._getVtabModule(moduleName) : undefined;
	return hasNativeEventSupport(moduleReg?.module);
}

/**
 * Returns true when the target table's owning *module* guarantees per-scan
 * snapshot isolation — a `query()` iterator sees a stable snapshot even if
 * `update()` mutates the same table mid-scan. Consulted by runUpdate/runDelete
 * to decide whether a predicate DELETE/UPDATE may stream the source scan or must
 * first drain it (physical Halloween avoidance). Consults the MODULE, not the
 * vtab instance — mirrors moduleHasNativeDataEvents. Default (flag unset) =
 * false = not snapshot-isolated = drain before mutating.
 */
function moduleHasScanSnapshotIsolation(ctx: RuntimeContext, tableSchema: TableSchema): boolean {
	const moduleName = tableSchema.vtabModuleName;
	const moduleReg = moduleName ? ctx.db._getVtabModule(moduleName) : undefined;
	return moduleReg?.module?.scanSnapshotIsolation === true;
}

/**
 * Fully drain a source scan into an in-memory array, closing the scan cursor
 * before any write is applied. This is the read-phase / write-phase separation
 * that avoids the physical Halloween hazard for modules WITHOUT per-scan
 * snapshot isolation: a predicate DELETE/UPDATE must finish reading which rows
 * to change before it starts changing them, or the first write invalidates the
 * cursor path the scan is still walking. Reads are side-effect-free, so draining
 * before the statement savepoint opens is safe.
 */
async function drainSourceRows(rows: AsyncIterable<Row>): Promise<Row[]> {
	const buffered: Row[] = [];
	for await (const row of rows) {
		buffered.push(row);
	}
	return buffered;
}

/**
 * Resolve the row source a predicate UPDATE/DELETE feeds to
 * `runWithStatementSavepoints`: stream it verbatim when the target module has
 * per-scan snapshot isolation, otherwise drain it up front (read/write phase
 * separation — see {@link drainSourceRows}).
 *
 * The drain is consumed HERE, outside `runWithStatementSavepoints`' try/finally,
 * so a scan or abort error mid-drain would otherwise skip the target vtab's
 * `disconnect()` that finally guarantees. Guard it: on a drain failure, disconnect
 * the already-connected target vtab before propagating, matching the streaming
 * path (where the source is consumed inside that try/finally).
 */
async function resolveDmlSourceRows(
	ctx: RuntimeContext,
	vtab: VirtualTable,
	tableSchema: TableSchema,
	rows: AsyncIterable<Row>,
): Promise<AsyncIterable<Row> | Iterable<Row>> {
	if (moduleHasScanSnapshotIsolation(ctx, tableSchema)) {
		return rows;
	}
	try {
		return await drainSourceRows(rows);
	} catch (e) {
		await disconnectVTable(ctx, vtab);
		throw e;
	}
}

/**
 * The row the substrate actually STORED for this write, which is what every
 * post-write consumer must see. The executor's own writes are converted by the
 * emitters up front (and passed with `preCoerced`), so for the standard
 * backends `result.row` and the row we handed in now usually agree — but a
 * module remains free to normalize further (or to ignore `preCoerced` and
 * convert on its own), and `result.row` is its word on what landed.
 *
 * Falls back to the raw row when the substrate's row is the wrong width — a
 * minimal test/sample module that echoes its input in a different shape. The
 * absent case is only reached defensively: every caller has already
 * short-circuited on a missing `result.row`, which the module contract
 * reserves for "nothing was written" (see `VirtualTable.update`).
 */
function storedRowOrRaw(resultRow: Row | undefined, rawRow: Row, columnCount: number): Row {
	return resultRow && resultRow.length === columnCount ? resultRow : rawRow;
}

/**
 * Rebuild the flat OLD/NEW row with its NEW section (indices n..2n-1) replaced by
 * the substrate's stored row, so `RETURNING new.<col>` reports the same value and
 * `typeof` as a subsequent `select`. Returns `flatRow` untouched when the stored
 * row IS the raw NEW section (the fallback above), avoiding a per-row copy.
 *
 * NOTE: on a coercing substrate this allocates one array per written row (the
 * DML executor previously yielded `flatRow` verbatim). It is one copy against a
 * per-row `vtab.update()` await, so it does not register today; if bulk-INSERT
 * throughput ever shows this as hot, have the substrates report which columns
 * coercion actually changed and patch only those in place.
 */
function withStoredNewSection(flatRow: Row, storedRow: Row, rawNewRow: Row, columnCount: number): Row {
	if (storedRow === rawNewRow) return flatRow;
	const out = flatRow.slice() as Row;
	for (let i = 0; i < columnCount; i++) {
		out[columnCount + i] = storedRow[i];
	}
	return out;
}

/**
 * Emit an automatic data change event for modules without native event support.
 */
function emitAutoDataEvent(
	ctx: RuntimeContext,
	tableSchema: TableSchema,
	type: 'insert' | 'update' | 'delete',
	key: SqlValue[],
	oldRow?: Row,
	newRow?: Row,
	changedColumns?: string[]
): void {
	ctx.db._getEventEmitter().emitAutoDataEvent(
		tableSchema.vtabModuleName ?? 'memory',
		{
			type,
			schemaName: tableSchema.schemaName,
			tableName: tableSchema.name,
			key,
			oldRow,
			newRow,
			changedColumns,
			remote: false, // Auto-emitted events are always local
		}
	);
}

/**
 * Synchronously drive row-time (write-through) materialized-view maintenance for
 * one source row-write, immediately after the change is recorded. A no-op fast
 * path (one synchronous map lookup) when no `row-time` MV depends on `tableKey`,
 * so non-covered tables pay effectively nothing. The maintenance writes the
 * covering MV's backing table within the same transaction (visible mid-statement;
 * committed/rolled-back in lockstep with this write) — see
 * `core/database-materialized-views.ts` § row-time write-through.
 *
 * `cache` is the per-statement {@link BackingConnectionCache} the generator owns: it
 * amortizes the backing-connection resolution over the whole statement (one scan per
 * backing instead of one per source row) while still applying each bounded-delta arm's
 * ops immediately, so within-statement enforcement visibility is unchanged.
 *
 * `deferred` is the per-statement deferred-rebuild set the generator owns: a full-rebuild
 * covering MV is marked dirty here (not applied per row) and rebuilt once at the
 * end-of-statement flush ({@link runWithStatementSavepoints}).
 *
 * `residualBatch` is the per-statement residual key batch the generator owns: a
 * residual-arm covering MV (`'residual-recompute'` / `'prefix-delete'` /
 * `'join-residual'`) accumulates the changed row's affected binding key(s) here (deduped
 * across the statement) instead of recomputing per row, and each distinct key's residual
 * runs once at the same end-of-statement flush. Only the `'inverse-projection'` arm stays
 * per-row-immediate — the covering-UNIQUE enforcement scan reads its backing
 * mid-statement, and its per-row delta is a cheap pure projection.
 */
async function maintainRowTimeStructures(
	ctx: RuntimeContext,
	tableKey: string,
	change: BackingRowChange,
	cache: BackingConnectionCache,
	deferred: Set<string>,
	residualBatch: ResidualKeyBatch,
): Promise<void> {
	if (!ctx.db._hasRowTimeCoveringStructures(tableKey)) return;
	await ctx.db._maintainRowTimeCoveringStructures(tableKey, change, cache, deferred, residualBatch);
}

/**
 * Evaluate the per-statement mutation-context evaluators once, producing the
 * context row passed to the mutation-statement builders (or undefined when
 * there are no context evaluators). Shared by all three DML generators.
 */
async function evaluateContextRow(
	ctx: RuntimeContext,
	contextEvaluators: Array<(ctx: RuntimeContext) => OutputValue>,
): Promise<Row | undefined> {
	if (contextEvaluators.length === 0) return undefined;
	const contextRow: SqlValue[] = [];
	for (const evaluator of contextEvaluators) {
		contextRow.push(await evaluator(ctx) as SqlValue);
	}
	return contextRow as Row;
}

/**
 * Engine-level READONLY backstop for maintained tables — the defense-in-depth
 * second net behind plan-time write-through dispatch.
 *
 * A maintained table's rows are *derived* (it carries a {@link TableDerivation};
 * `schema/derivation.ts`). The only engine surfaces permitted to write them are
 * the privileged backing-host paths (`applyMaintenance` / `replaceContents`, the
 * attach/refresh reconcile, the store rehydrate-refill, the isolation flush
 * `trustedWrite`) — none of which route through the DML executor. User DML naming
 * a maintained table is rewritten to **write-through** against the body's base
 * source at plan time (the three DML builders' view-mutation dispatch + the
 * resolved-schema backstop), so a `DmlExecutorNode` whose target still carries a
 * derivation can only be a plan-time mis-dispatch — a direct-write plan that
 * would silently diverge the derived contents from the source. This converts that
 * whole bug class into a loud READONLY error at emit time.
 *
 * Keyed structurally on `derivation` presence ({@link isMaintainedTable}) — never
 * on the table name. Emit-time (a single prepare-time check), not per-row: zero
 * runtime cost, and re-checked on every re-plan because `set / drop maintained`
 * invalidate the `'table'` statement-cache dependency. Exported so a spec test can
 * exercise it directly with a derivation-bearing schema: the backstop is
 * deliberately unreachable from SQL (plan-time dispatch routes every reachable
 * spelling away from it), so the exported guard plus the one wiring call site is
 * the honest pin.
 */
export function assertNotMaintainedTableTarget(tableSchema: TableSchema): void {
	if (isMaintainedTable(tableSchema)) {
		throw new QuereusError(
			`table '${tableSchema.schemaName}.${tableSchema.name}' is a maintained table — its contents are derived `
			+ `and may not be written directly (user DML routes through write-through; this plan bypassed the dispatch — engine bug)`,
			StatusCode.READONLY,
		);
	}
}

export function emitDmlExecutor(plan: DmlExecutorNode, ctx: EmissionContext): Instruction {
	const tableSchema = plan.table.tableSchema;

	// READONLY backstop: a DmlExecutorNode targeting a maintained table is a
	// plan-time mis-dispatch (user DML should have been rewritten to write-through
	// against the base source). Reject loudly rather than letting a direct write
	// silently diverge the derived contents — see assertNotMaintainedTableTarget.
	assertNotMaintainedTableTarget(tableSchema);

	// Pre-calculate primary key column indices from schema (needed for update/delete)
	const pkColumnIndicesInSchema = tableSchema.primaryKeyDefinition.map(pkColDef => pkColDef.index);

	// QUEREUS_REPR_STRICT seam: the row about to be handed to `vtab.update`, checked
	// against the declared column types AFTER the DML pipeline's coercion pass. This is
	// the failure mode with the longest fuse — a non-canonical value that gets PERSISTED.
	// Both arrays are built only when the flag is on, so a normal emit allocates nothing
	// on the checker's behalf.
	// The three row-bearing `vtab.update` sites below each call `assertRowConforms` under
	// `if (REPR_STRICT)`, immediately before the write and deliberately OUTSIDE the
	// conversion/constraint `catch` blocks, so a violation propagates as the internal error
	// it is rather than being re-reported as a constraint failure. DELETE carries no row, so
	// it has no check.
	const reprColumnTypes = REPR_STRICT ? tableSchema.columns.map(col => col.logicalType) : undefined;
	const reprColumnNames = REPR_STRICT ? tableSchema.columns.map(col => col.name) : undefined;
	const reprWhere = REPR_STRICT ? `write to ${tableSchema.schemaName}.${tableSchema.name}` : '';

	// Per-PK-column comparators for the data-event contract's relocation test: an UPDATE
	// whose key values differ under the PRIMARY KEY's own comparator MOVES the row, and the
	// contract delivers that as delete-at-old-key + insert-at-new-key rather than one `update`
	// (docs/usage.md § Subscribing to Data Changes). Built through the shared UNIQUE-enforcement
	// rule so the test is collation- and type-aware — never raw value equality, which would
	// mis-classify a NOCASE case-only rewrite ('apple' → 'APPLE') as a move when the row never
	// left its slot. Resolved once here (the resolver throws on an unregistered name and
	// records the collation dependency so a redefined collation re-emits).
	const pkEventComparators = uniqueEnforcementComparators(
		tableSchema.columns,
		pkColumnIndicesInSchema,
		tableSchema.primaryKeyDefinition.map(pkColDef => ctx.resolveCollation(pkColDef.collation ?? 'BINARY')),
	);

	// Emit mutation context evaluators if present
	const contextEvaluatorInstructions: Instruction[] = [];
	if (plan.mutationContextValues && plan.contextAttributes) {
		for (const attr of plan.contextAttributes) {
			const valueNode = plan.mutationContextValues.get(attr.name);
			if (!valueNode) {
				// Invariant, not user input: the DML builders fill EVERY declared context
				// slot — the supplied value expression, or a NULL literal when the statement
				// omitted the variable (planner/building/mutation-context.ts). A gap here
				// would silently shift the evaluated context row against contextDescriptor.
				throw new QuereusError(`Internal: no mutation context evaluator for '${attr.name}'`, StatusCode.INTERNAL);
			}
			const instruction = emitCallFromPlan(valueNode, ctx);
			contextEvaluatorInstructions.push(instruction);
		}
	}

	// Build UPSERT clause metadata and emit evaluator instructions
	// All evaluators are collected into a single array that gets passed as params
	const upsertEvaluatorInstructions: Instruction[] = [];
	let runtimeUpsertClauses: RuntimeUpsertClause[] | undefined;

	if (plan.upsertClauses && plan.upsertClauses.length > 0) {
		runtimeUpsertClauses = plan.upsertClauses.map(clause => {
			const runtime: RuntimeUpsertClause = {
				conflictTargetIndices: clause.conflictTargetIndices,
				action: clause.action,
				whereIndex: -1,
				newRowDescriptor: clause.newRowDescriptor,
				existingRowDescriptor: clause.existingRowDescriptor,
			};

			// Resolve the per-target-column enforcement collation NAMES to functions once
			// here (recording the collation dependency so a redefined collation re-emits),
			// then build the per-column comparators through the shared UNIQUE-enforcement
			// rule. Consumed by matchUpsertClause so a conflict the targeted constraint
			// considers a duplicate — collation-equal, or semantically equal under a
			// semantic-ordering declared type — routes to DO UPDATE / DO NOTHING instead
			// of aborting.
			if (clause.conflictTargetIndices && clause.conflictTargetCollations) {
				const collationFns = clause.conflictTargetCollations.map(
					name => ctx.resolveCollation(name ?? 'BINARY'),
				);
				runtime.conflictTargetComparators = uniqueEnforcementComparators(
					tableSchema.columns,
					clause.conflictTargetIndices,
					collationFns,
				);
			}

			if (clause.action === 'update' && clause.assignments) {
				runtime.assignmentIndices = new Map();
				runtime.assignmentCoercions = new Map();
				// Split the map into the user's SET targets and the appended
				// generated-column recomputes — the latter run as a second pass.
				const generatedColumns = new Set(clause.generatedAssignmentColumns ?? []);
				const generatedEvaluatorIndices = new Map<number, number>();
				for (const [colIndex, valueNode] of clause.assignments) {
					const evaluatorIndex = upsertEvaluatorInstructions.length;
					const instruction = emitCallFromPlan(valueNode, ctx);
					upsertEvaluatorInstructions.push(instruction);
					if (generatedColumns.has(colIndex)) {
						generatedEvaluatorIndices.set(colIndex, evaluatorIndex);
					} else {
						runtime.assignmentIndices.set(colIndex, evaluatorIndex);
					}
					// Same decision as emitUpdate, from the same helper: convert unless the
					// assignment expression's type IS the column's declared type AND the
					// value already inhabits it. Applies to a generated value too — it is
					// written to the same cell.
					const column = tableSchema.columns[colIndex];
					const coerce = buildCellCoercion(valueNode.getType().logicalType, column.logicalType, column.name);
					if (coerce) {
						runtime.assignmentCoercions.set(colIndex, coerce);
					}
				}
				// Keep topological order (drive off the plan's list, not map order).
				if (generatedEvaluatorIndices.size > 0) {
					runtime.generatedAssignments = clause.generatedAssignmentColumns!
						.filter(colIndex => generatedEvaluatorIndices.has(colIndex))
						.map(colIndex => ({ colIndex, evaluatorIndex: generatedEvaluatorIndices.get(colIndex)! }));
					// Sparse array indexed by attribute id — `slice` preserves the holes.
					// Missing it would make the runtime skip the recompute SILENTLY, so
					// treat it as the plan-shape violation it is rather than degrading.
					if (!clause.existingRowDescriptor) {
						throw new QuereusError(
							`UPSERT DO UPDATE on '${tableSchema.name}' has generated-column recomputes but no existing-row descriptor`,
							StatusCode.INTERNAL
						);
					}
					runtime.generatedRowDescriptor = clause.existingRowDescriptor.slice();
				}
			}

			if (clause.whereCondition) {
				runtime.whereIndex = upsertEvaluatorInstructions.length;
				const whereInstruction = emitCallFromPlan(clause.whereCondition, ctx);
				upsertEvaluatorInstructions.push(whereInstruction);
			}

			return runtime;
		});
	}

	/**
	 * Emit-time shape of the DO UPDATE arm's UPDATE-shaped row validation — the
	 * evaluator positions plus everything {@link evaluateRowConstraints} needs that
	 * does not vary per row. See {@link UpsertUpdateValidation} for why the arm needs
	 * its own validation at all.
	 */
	interface UpsertValidationRuntime {
		scope: RowConstraintScope;
		metadata: ConstraintMetadataEntry[];
		/** First position of the CHECK / FK evaluators within `upsertEvaluators`. */
		checkStart: number;
		checkCount: number;
		/** NOT NULL DEFAULT evaluators, already resolved to their `upsertEvaluators` position. */
		notNullDefaults: Array<{ columnIndex: number; evaluatorIndex: number; coerce?: (value: SqlValue) => SqlValue }>;
		/** Flat OLD|NEW descriptor, used when the statement has no mutation context. */
		flatDescriptor: RowDescriptor;
		/** Context-prefixed descriptor, used when it does. */
		combinedDescriptor?: RowDescriptor;
	}

	// The DO UPDATE arm's validation evaluators are appended to the SAME array the
	// clause's own evaluators use: runInsert already slices everything after the
	// context evaluators into `upsertEvaluators`, so neither the params layout nor
	// the `run` signature changes.
	const upsertValidation = plan.upsertUpdateValidation;
	let upsertValidationRuntime: UpsertValidationRuntime | undefined;
	if (upsertValidation) {
		const checkStart = upsertEvaluatorInstructions.length;
		const checkInstructions = upsertValidation.checks.map(check => emitCallFromPlan(check.expression, ctx));
		upsertEvaluatorInstructions.push(...checkInstructions);

		const defaultStart = upsertEvaluatorInstructions.length;
		const defaultInstructions = upsertValidation.notNullDefaults.map(d => emitCallFromPlan(d.defaultNode, ctx));
		upsertEvaluatorInstructions.push(...defaultInstructions);

		upsertValidationRuntime = {
			scope: { operation: RowOpFlag.UPDATE, hasNewSection: true },
			metadata: buildConstraintMetadata(
				upsertValidation.checks,
				tableSchema,
				upsertValidation.flatRowDescriptor,
				plan.contextDescriptor,
				checkInstructions.map(instruction => instruction.run),
			),
			checkStart,
			checkCount: checkInstructions.length,
			notNullDefaults: upsertValidation.notNullDefaults.map((d, i) => ({
				columnIndex: d.columnIndex,
				evaluatorIndex: defaultStart + i,
				// Same decision as everywhere else a DEFAULT is substituted after the
				// emitters' conversion pass — see NotNullDefaultRuntime.coerce.
				coerce: buildCellCoercion(
					d.defaultNode.getType().logicalType,
					tableSchema.columns[d.columnIndex].logicalType,
					tableSchema.columns[d.columnIndex].name,
				),
			})),
			flatDescriptor: upsertValidation.flatRowDescriptor,
			combinedDescriptor: plan.contextDescriptor
				? composeCombinedDescriptor(plan.contextDescriptor, upsertValidation.flatRowDescriptor)
				: undefined,
		};
	}

	// --- Operation-specific run generators ------------------------------------

	/**
	 * Match an UPSERT clause against a unique constraint violation.
	 *
	 * The vtab's constraint result reports the conflicting `existingRow` but not
	 * which specific UNIQUE constraint fired. We therefore infer the match by
	 * value: a clause covers the conflict only when the proposed row equals the
	 * existing row at every one of the clause's conflict-target columns. This is
	 * what scopes `DO NOTHING` / `DO UPDATE` to its declared target — including a
	 * PK-targeted clause, which simply has the PK columns as its targets. A
	 * conflict on a *different* unique constraint (e.g. a secondary UNIQUE) leaves
	 * the target columns unequal, so no clause matches and the caller aborts with
	 * a UNIQUE constraint error.
	 *
	 * Returns the matching clause if found, undefined otherwise.
	 */
	function matchUpsertClause(
		existingRow: Row,
		proposedRow: Row,
		clauses: RuntimeUpsertClause[]
	): RuntimeUpsertClause | undefined {
		for (const clause of clauses) {
			if (!clause.conflictTargetIndices) {
				// No conflict target specified - matches any unique constraint
				return clause;
			}

			// The conflict is on this clause's target columns when the proposed row
			// equals the existing one there, compared the way the constraint ENFORCES
			// (see {@link conflictTargetValuesMatch}): an affinity-coerced, a
			// collation-equal or a semantically-equal conflict all route to the DO
			// UPDATE / DO NOTHING arm rather than aborting with a UNIQUE error, while
			// a BINARY byte-identical key still compares 0 (so seed idempotency, which
			// re-presents identical literals, is unaffected).
			//
			// NOTE: one residual corner remains out of scope — multi-constraint
			// coincidence. If an insert violates the targeted constraint AND another
			// unique constraint at once and the vtab returns the targeted constraint's
			// existingRow, the row is still suppressed though the uncovered conflict
			// should abort. The vtab short-circuits on the first violation, so even full
			// constraint-identity tracking couldn't fix this without it reporting every
			// violated constraint; value comparison cannot disambiguate it.
			const conflictMatch = clause.conflictTargetIndices.every((idx, targetPos) =>
				conflictTargetValuesMatch(existingRow[idx], proposedRow[idx], clause, targetPos)
			);

			if (conflictMatch) {
				return clause;
			}
		}
		return undefined;
	}

	/**
	 * Run the DO UPDATE arm's UPDATE-shaped validation against the row the arm has
	 * composed, exactly as the equivalent plain `UPDATE` would be validated:
	 * OLD = the conflicting stored row, NEW = the composed row.
	 *
	 * Returns false when a per-constraint IGNORE says to skip the row silently;
	 * otherwise true, having written any REPLACE DEFAULT substitution back into
	 * `updatedRow` in place (that substituted row is what gets stored). A violation
	 * under any other conflict action throws, which propagates out of
	 * `processInsertRow` into `runWithStatementSavepoints` and rolls the statement
	 * savepoint back — so a multi-row INSERT stays all-or-nothing.
	 *
	 * A no-op when the plan carries no validation (a DO NOTHING-only statement, or a
	 * plain INSERT).
	 */
	async function validateUpsertUpdatedRow(
		rctx: RuntimeContext,
		existingRow: Row,
		updatedRow: Row,
		contextRow: Row | undefined,
		upsertEvaluators: SubProgram[],
	): Promise<boolean> {
		const validation = upsertValidationRuntime;
		if (!validation) return true;

		const flatRow: Row = [...existingRow, ...updatedRow];
		// The check expressions read the row through a lazy getter, so a REPLACE NOT
		// NULL DEFAULT substitution mid-evaluation is visible to the CHECK / FK pass
		// that follows it — same contract as emitConstraintCheck.
		let visibleRow: Row = flatRow;

		const checkEvaluators = upsertEvaluators.slice(
			validation.checkStart, validation.checkStart + validation.checkCount);
		const notNullDefaults: NotNullDefaultRuntime[] = validation.notNullDefaults.map(d => ({
			columnIndex: d.columnIndex,
			evaluator: upsertEvaluators[d.evaluatorIndex],
			coerce: d.coerce,
		}));

		const useContext = contextRow !== undefined && validation.combinedDescriptor !== undefined;
		const descriptor = useContext ? validation.combinedDescriptor! : validation.flatDescriptor;

		const result = await withAsyncRowContext(
			rctx,
			descriptor,
			() => useContext ? [...contextRow!, ...visibleRow] : visibleRow,
			() => evaluateRowConstraints(
				rctx,
				validation.scope,
				tableSchema,
				flatRow,
				validation.metadata,
				checkEvaluators,
				// NOTE: `plan.onConflict` is undefined on every path reachable today —
				// the parser rejects `insert or ... on conflict ...` outright and no
				// synthesized statement sets both — so this is behaviorally identical to
				// passing undefined. Threaded anyway so the arm stays honest if that
				// guard is ever relaxed; do not read it as live behavior.
				plan.onConflict,
				notNullDefaults,
				contextRow,
				row => { visibleRow = row; },
			),
		);

		if (result.skip) return false;

		if (result.replacedRow) {
			// REPLACE substituted a NOT NULL column's DEFAULT — copy the substituted NEW
			// section back over the row that is about to be stored.
			const numCols = tableSchema.columns.length;
			for (let i = 0; i < numCols; i++) {
				updatedRow[i] = result.replacedRow[numCols + i];
			}
		}
		return true;
	}

	/**
	 * Execute the DO UPDATE path for an UPSERT clause.
	 * Returns the updated row or undefined if WHERE condition fails.
	 */
	async function executeUpsertUpdate(
		rctx: RuntimeContext,
		vtab: VirtualTable,
		clause: RuntimeUpsertClause,
		existingRow: Row,
		proposedRow: Row,
		contextRow: Row | undefined,
		upsertEvaluators: SubProgram[]
	): Promise<{ updatedRow: Row; flatRow: Row } | undefined> {
		// Check WHERE condition if present
		if (clause.whereIndex >= 0 && clause.newRowDescriptor && clause.existingRowDescriptor) {
			const whereEvaluator = upsertEvaluators[clause.whereIndex];
			// Evaluate WHERE with both NEW (proposed) and existing row contexts
			const whereResult = await withAsyncRowContext(rctx, clause.existingRowDescriptor, () => existingRow, async () => {
				return await withAsyncRowContext(rctx, clause.newRowDescriptor!, () => proposedRow, async () => {
					return await whereEvaluator(rctx);
				});
			});

			// If WHERE evaluates to false/null, skip this row (DO NOTHING equivalent)
			if (!whereResult) {
				return undefined;
			}
		}

		// Build the updated row by starting with existing row and applying assignments
		const updatedRow = [...existingRow] as Row;

		if (clause.assignmentIndices && clause.newRowDescriptor && clause.existingRowDescriptor) {
			// Evaluate assignment expressions with proper contexts
			for (const [colIndex, evaluatorIndex] of clause.assignmentIndices) {
				const evaluator = upsertEvaluators[evaluatorIndex];
				let value = await withAsyncRowContext(rctx, clause.existingRowDescriptor, () => existingRow, async () => {
					return await withAsyncRowContext(rctx, clause.newRowDescriptor!, () => proposedRow, async () => {
						return await evaluator(rctx);
					});
				}) as SqlValue;
				// Convert to the declared column type as the assignment requires (see
				// assignmentCoercions) — `existingRow` is a stored row, so the composed
				// updatedRow is then fully declared-form.
				const coerce = clause.assignmentCoercions?.get(colIndex);
				if (coerce) {
					value = coerce(value);
				}
				updatedRow[colIndex] = value;
			}
		}

		// Phase 2: recompute the generated columns against the row as composed above,
		// which now holds the CONVERTED user assignments — a generated column derives
		// from what will be STORED, not from the raw assignment. It cannot run in the
		// pass above: there the existing-row attributes still resolve to PRE-update
		// values. Here they are re-bound — through a descriptor object of their own, see
		// {@link RuntimeUpsertClause.generatedRowDescriptor} — to the live `updatedRow`,
		// which each iteration writes back into, so a generated-from-generated column
		// reads the value its dependency just produced.
		//
		// `await` each evaluator: deterministic does not imply synchronous — a generated
		// expression may embed a scalar subquery, whose evaluator returns a Promise (see
		// the same note in emitUpdate's phase 2).
		//
		// NOTE: each value is converted before the next generated column reads it, whereas
		// emitUpdate converts the whole row once after its phase-2 loop. The two agree
		// unless a generated column reads another whose expression type differs from its
		// declared type; if such a divergence is ever observed, make emitUpdate convert
		// per-column too (this order is the correct one — a dependent should see the
		// stored form).
		if (clause.generatedAssignments && clause.generatedRowDescriptor) {
			await withAsyncRowContext(rctx, clause.generatedRowDescriptor, () => updatedRow, async () => {
				for (const { colIndex, evaluatorIndex } of clause.generatedAssignments!) {
					let value = await upsertEvaluators[evaluatorIndex](rctx) as SqlValue;
					const coerce = clause.assignmentCoercions?.get(colIndex);
					if (coerce) {
						value = coerce(value);
					}
					updatedRow[colIndex] = value;
				}
			});
		}

		// UPDATE-shaped validation of the composed row. It runs HERE — after the
		// generated-column recompute, before anything is written — because this is the
		// first point at which the row that will actually be stored exists.
		//
		// NOTE: the statement's INSERT-shaped ConstraintCheckNode has already run on the
		// PROPOSED row, before the conflict was known (matching SQLite). One consequence:
		// an auto-deferred (subquery-bearing) INSERT-shaped CHECK was queued against that
		// proposed row and is evaluated at COMMIT, so it can abort the transaction over a
		// row that was never stored. That is the deferred twin of the immediate behavior
		// and is consistent with it — out of scope here.
		if (!await validateUpsertUpdatedRow(rctx, existingRow, updatedRow, contextRow, upsertEvaluators)) {
			return undefined;
		}

		// Parent-side RESTRICT enforcement for the referenced-column changes this arm
		// makes. Mirrors runUpdate's non-batched branch and must sit BEFORE vtab.update
		// for the same reason documented there: on a rowid-mode backend a post-mutation
		// OLD-value scan dereferences through the just-mutated parent and finds nothing.
		// runInsert owns no ParentRestrictBatch, so this is always the per-row pre-walk.
		//
		// NOTE: this pre-walk is the arm's ONLY parent-side RESTRICT enforcement whenever
		// the table clears the batchability gate — buildUpsertUpdateValidation drops the
		// plan-time `not exists` probes there, matching buildUpdateStmt, so both spellings
		// report the same message. The arm still never gets the end-of-statement batched
		// probe a plain UPDATE can, paying one probe per conflicting row instead. Fine at
		// current scale; if bulk upsert against a heavily-referenced parent ever shows up
		// as slow, give runInsert a ParentRestrictBatch the way runUpdate has one.
		await assertTransitiveRestrictsForParentMutation(
			rctx.db, tableSchema, 'update', existingRow, updatedRow, plan.lensRouted);

		// Extract the primary key from existing row
		const keyValues = pkColumnIndicesInSchema.map(idx => existingRow[idx]);

		// Perform the UPDATE operation. `preCoerced`: the row is composed of
		// stored cells plus assignments already converted above.
		const updateArgs: UpdateArgs = {
			operation: 'update',
			values: updatedRow,
			oldKeyValues: keyValues,
			onConflict: ConflictResolution.ABORT,
			preCoerced: true,
			mutationStatement: vtab.wantStatements ?
				buildUpdateStatement(tableSchema, updatedRow, keyValues, contextRow) : undefined
		};

		if (REPR_STRICT) assertRowConforms(updatedRow, reprColumnTypes!, reprWhere, reprColumnNames);

		const updateResult = await vtab.update!(updateArgs);

		if (isConstraintViolation(updateResult)) {
			throw new ConstraintError(
				updateResult.message ?? `${updateResult.constraint} constraint failed during UPSERT update`,
				StatusCode.CONSTRAINT
			);
		}

		if (!updateResult.row) {
			return undefined;
		}

		// Report the row the substrate STORED, not the one we composed — see
		// storedRowOrRaw. `existingRow` is already a stored (coerced) row.
		const storedRow = storedRowOrRaw(updateResult.row, updatedRow, tableSchema.columns.length);

		// Build a flat row for RETURNING (OLD = existing, NEW = stored)
		const flatRow: Row = [...existingRow, ...storedRow];

		return { updatedRow: storedRow, flatRow };
	}

	/**
	 * Translate a generic ConstraintError into the right OR-clause subclass
	 * based on the active statement-level conflict resolution. FAIL and
	 * RollbackConflictError pass through unchanged. The iterator-level
	 * cleanup uses the subclass to decide commit-vs-rollback semantics.
	 */
	function translateConflictError(
		err: unknown,
		stmtOR: ConflictResolution | undefined,
	): unknown {
		if (!(err instanceof ConstraintError)) return err;
		if (err instanceof FailConflictError || err instanceof RollbackConflictError) return err;

		if (stmtOR === ConflictResolution.FAIL) {
			return new FailConflictError(err.message, err.code);
		}
		if (stmtOR === ConflictResolution.ROLLBACK) {
			return new RollbackConflictError(err.message, err.code);
		}
		return err;
	}

	/**
	 * Shared statement-/row-level savepoint scaffold for multi-row DML, used by
	 * all three generators. Owns the savepoint lifecycle that makes a multi-row
	 * mutation atomic inside an explicit transaction, plus the per-row OR FAIL
	 * savepoint that keeps prior rows while undoing only the failing row.
	 * INSERT/UPDATE/DELETE reduce to a `processRow` closure carrying the
	 * operation-specific body (vtab.update + bookkeeping + FK actions + events).
	 *
	 * - non-FAIL (ABORT default / IGNORE / REPLACE / ROLLBACK): one
	 *   statement-scope savepoint, released after the loop completes and
	 *   rolled-back-and-released on ANY throw escaping the loop — whether from
	 *   the source iterator (e.g. a ConstraintCheckNode above the executor
	 *   raising NOT NULL / CHECK before a row is yielded) or from `processRow`
	 *   (a vtab-returned constraint, or a RESTRICT pre-check). This is the
	 *   statement-atomicity guarantee, mirroring SQLite's implicit
	 *   per-statement savepoint: all of a statement's row effects apply or none.
	 * - OR FAIL: per-row savepoint, released on success, rolled back on throw,
	 *   so the failing row's partial work (incl. a row-time backing write that
	 *   lands before a later maintenance throw) is undone while earlier rows
	 *   survive. FAIL deliberately skips the statement-scope wrap.
	 *
	 * Always uses the broadcast savepoint helpers so per-connection savepoint
	 * stacks stay in lockstep with the TransactionManager's stack — including a
	 * connection registered lazily mid-statement (the row-time backing
	 * connection registers on the first maintenance call; Database.registerConnection
	 * replays the active savepoint depth onto it, which already includes the
	 * statement savepoint created before the row loop).
	 */
	async function* runWithStatementSavepoints(
		ctx: RuntimeContext,
		vtab: VirtualTable,
		// AsyncIterable when streaming the source scan (INSERT, and
		// snapshot-isolated UPDATE/DELETE targets); a buffered Row[] when a
		// non-snapshot-isolated UPDATE/DELETE has drained its source up front to
		// separate the read phase from the write phase. `for await ... of`
		// consumes either — the savepoint/FAIL-mode logic below is unchanged.
		rows: AsyncIterable<Row> | Iterable<Row>,
		isFailMode: boolean,
		processRow: (flatRow: Row) => Promise<Row | undefined>,
		deferredRebuilds: Set<string>,
		residualBatch: ResidualKeyBatch,
		backingConnCache: BackingConnectionCache,
		// Set only when the statement uses batched parent-side RESTRICT
		// enforcement (see getBatchableRestrictFks): flushes the accumulated
		// key batch at the end-of-statement boundary. The gate excludes FAIL,
		// so a non-null flush always runs under the statement savepoint.
		flushFkBatch?: () => Promise<void>,
	): AsyncIterable<Row> {
		let failSavepointCounter = 0;

		// For non-FAIL modes wrap the whole statement so a mid-statement failure
		// unwinds partial writes from earlier rows. FAIL keeps prior rows, so it
		// uses the per-row savepoint (opened inside the loop) instead. Share the
		// module-scope counter so a cascade-nested savepoint name (e.g. an FK
		// cascade UPDATE during a parent UPDATE) can't collide with the parent's.
		const stmtSavepointName = !isFailMode
			? `__stmt_atomic_${stmtSavepointCounter++}`
			: undefined;
		if (stmtSavepointName) {
			await ctx.db._createSavepointBroadcast(stmtSavepointName);
		}

		try {
			try {
				for await (const flatRow of rows) {
					// Cooperative cancellation checkpoint for scan-less / output-less
					// mutations. A bulk INSERT/UPDATE/DELETE whose source is not a table
					// scan (e.g. INSERT … VALUES, or INSERT … SELECT from a TVF / CTE with
					// no base-table read) is reached by neither the scan-leaf checkpoint
					// nor the statement output-row boundary, so without this poll a
					// caller's abort could only take effect once the whole drain finished.
					// Polling once per source row interrupts the drain at the next row
					// boundary; the throw routes through the savepoint machinery below,
					// unwinding this statement's partial writes. Cheap relative to the
					// per-row vtab.update() this loop already awaits.
					throwIfAborted(ctx.signal);

					// OR FAIL per-row savepoint. Broadcast (not the bare variant)
					// so a connection registering mid-row keeps its stack in
					// lockstep — see the doc comment above.
					let savepointName: string | undefined;
					if (isFailMode) {
						savepointName = `__or_fail_${failSavepointCounter++}`;
						await ctx.db._createSavepointBroadcast(savepointName);
					}

					let rowToYield: Row | undefined;
					let succeeded = false;
					try {
						rowToYield = await processRow(flatRow);
						succeeded = true;
					} catch (e) {
						if (savepointName) {
							await ctx.db._rollbackAndReleaseSavepointBroadcast(savepointName);
							savepointName = undefined;
							// The savepoint reverted the failing row's source/backing writes,
							// but the residual batch's JS-side DELTA accumulations cannot be
							// unwound and may carry the reverted row's contribution. The
							// residual KEYS stay valid (a reverted key recomputes from live
							// state to a value-identical row, which the host suppresses), so
							// drop only the delta fast path — the FAIL-mode flush below then
							// routes those entries through the plain residual.
							poisonResidualDeltaAccumulations(residualBatch);
						}
						// Translate plain constraint violations to FAIL/ROLLBACK error
						// subclasses so the iterator-level cleanup picks the right
						// finalization branch.
						throw translateConflictError(e, plan.onConflict);
					}

					if (succeeded && savepointName) {
						await ctx.db._releaseSavepointBroadcast(savepointName);
					}

					if (rowToYield !== undefined) {
						yield rowToYield;
					}
				}
				// End-of-statement boundary. First the batched parent-side RESTRICT
				// probe (fail fast — skip wasted MV work on a violation), then the
				// deferred maintenance; both BEFORE the statement savepoint releases
				// so a failure rolls the whole statement back. Inside the try, so an
				// error routes to the rollback branch below.
				if (flushFkBatch) {
					await flushFkBatch();
				}
				// Drain the deferred maintenance (residual key
				// batch + full-rebuild set) NOW — after every source row has been applied
				// (so each recompute/rebuild reads all this statement's writes) and BEFORE
				// the statement savepoint releases (so a failed flush rolls the whole
				// statement back). Inside the try, so a flush error routes to the rollback
				// branch below. A no-op when nothing deferred.
				if (deferredRebuilds.size > 0 || residualBatch.size > 0) {
					await ctx.db._flushDeferredMaintenance(deferredRebuilds, residualBatch, backingConnCache);
				}
				if (stmtSavepointName) {
					await ctx.db._releaseSavepointBroadcast(stmtSavepointName);
				}
			} catch (e) {
				if (stmtSavepointName) {
					await ctx.db._rollbackAndReleaseSavepointBroadcast(stmtSavepointName);
				} else if (deferredRebuilds.size > 0 || residualBatch.size > 0) {
					// OR FAIL keeps the rows that already succeeded (it runs with no
					// statement-scope savepoint), so a mid-statement abort does NOT unwind
					// them. Their deferred residual/full-rebuild MVs must therefore still be
					// flushed before the conflict error propagates — otherwise the backing
					// would lag the surviving source rows mid-transaction
					// (read(MV) != evaluate(body)). The failing row's own per-row savepoint
					// already reverted its writes, so the flush recomputes over exactly the
					// surviving rows (a reverted row's accumulated key is harmless — its
					// recompute is value-identical and suppressed). The original conflict
					// error is re-thrown after the flush. (A flush failure here is a genuine
					// maintenance error and supersedes the conflict error, matching "a
					// maintenance error fails the source write".)
					await ctx.db._flushDeferredMaintenance(deferredRebuilds, residualBatch, backingConnCache);
				}
				throw e;
			}
		} finally {
			await disconnectVTable(ctx, vtab);
		}
	}

	// INSERT ----------------------------------------------------
	// Number of context evaluators (used to split params in runInsert)
	const numContextEvaluators = contextEvaluatorInstructions.length;


	async function* runInsert(
		ctx: RuntimeContext,
		rows: AsyncIterable<Row>,
		...allEvaluators: Array<(ctx: RuntimeContext) => OutputValue>
	): AsyncIterable<Row> {
		// Split evaluators: first numContextEvaluators are context, rest are upsert
		const contextEvaluators = allEvaluators.slice(0, numContextEvaluators);
		const upsertEvaluators = allEvaluators.slice(numContextEvaluators) as SubProgram[];

		// Ensure we're in a transaction before any mutations (lazy/JIT transaction start)
		await ctx.db._ensureTransaction();

		const vtab = await getVTable(ctx, tableSchema);
		const needsAutoEvents = ctx.db._needsDataEvents() && !moduleHasNativeDataEvents(ctx, tableSchema);
		const contextRow = await evaluateContextRow(ctx, contextEvaluators);

		// Per-statement backing-connection cache: resolve each covering MV's backing
		// connection once for the whole statement rather than once per source row.
		const backingConnCache: BackingConnectionCache = new Map();
		// Per-statement deferred full-rebuild set (MV keys) + residual key batch:
		// full-rebuild covering MVs are marked dirty and residual-arm covering MVs
		// accumulate their affected binding keys during the row loop; both drain once
		// at the end-of-statement flush in runWithStatementSavepoints.
		const deferredRebuilds = new Set<string>();
		const residualBatch: ResidualKeyBatch = new Map();

		const isFailMode = plan.onConflict === ConflictResolution.FAIL;
		// Stamp the per-row mutation ordinal so a column `default` referencing
		// `mutation_ordinal()` (a per-row surrogate allocator) resolves to the 1-based
		// position of the row being produced. The defaults are evaluated upstream as
		// each row is *pulled*, so the ordinal is set BEFORE pulling — see
		// `stampMutationOrdinal`.
		yield* runWithStatementSavepoints(
			ctx, vtab, stampMutationOrdinal(ctx, rows), isFailMode,
			(flatRow) => processInsertRow(
				ctx, vtab, needsAutoEvents, flatRow, contextRow, runtimeUpsertClauses, upsertEvaluators, backingConnCache, deferredRebuilds, residualBatch,
			),
			deferredRebuilds, residualBatch, backingConnCache,
		);
	}

	/**
	 * Wrap the INSERT source so `rctx.mutationOrdinal` holds the 1-based ordinal of the
	 * row about to be produced. The column-default projection runs upstream when each
	 * row is *pulled*, so the ordinal is set immediately before `it.next()` — that pull
	 * drives the default evaluation for exactly that row, and `mutation_ordinal()` reads
	 * the just-set value. Saved/restored so a nested mutation (an FK cascade, a
	 * row-time backing write) does not see a stale ordinal, and cleared in `finally` so
	 * it never leaks past the statement.
	 */
	async function* stampMutationOrdinal(rctx: RuntimeContext, rows: AsyncIterable<Row>): AsyncIterable<Row> {
		const saved = rctx.mutationOrdinal;
		const it = rows[Symbol.asyncIterator]();
		let ordinal = 0;
		try {
			while (true) {
				rctx.mutationOrdinal = ordinal + 1;
				const next = await it.next();
				if (next.done) break;
				ordinal += 1;
				yield next.value;
			}
		} finally {
			rctx.mutationOrdinal = saved;
			if (it.return) await it.return();
		}
	}

	/**
	 * True when `oldRow` and `newRow` sit at DIFFERENT primary keys — the row relocated.
	 * Compares under {@link pkEventComparators} (per-column collation- and type-aware), so a
	 * key rewrite that leaves the row in its existing slot (a NOCASE 'apple' → 'APPLE') is
	 * NOT a relocation.
	 *
	 * NOTE: this verdict must match the SUBSTRATE's — the memory module decides the same
	 * question with `createPrimaryKeyFunctions`' comparators, a different construction. The two
	 * agree on every type in tree today (both fall through to `compareSqlValuesFast` under the
	 * column collation for TEXT, and to the declared type's `compare` for a semantic-ordering
	 * type). They could part company on a type that carries a `compare` WITHOUT
	 * `semanticOrdering` — DATE/TIME/DATETIME, whose `compare` is hard-wired to BINARY — if such
	 * a column ever became able to declare a non-BINARY collation, which the DDL currently
	 * refuses. If that changes, share one comparator factory instead: a disagreement here emits
	 * one `update` for a row the substrate actually moved. The same tripwire covers the STORE
	 * substrate, which reaches this path whenever a store table is registered WITHOUT its own
	 * emitter: it decides relocation from its encoded data key (`resolvePkKeyCollations`), a
	 * third construction that folds the same per-column collation.
	 */
	function primaryKeyRelocated(oldRow: Row, newRow: Row): boolean {
		return pkColumnIndicesInSchema.some(
			(colIdx, i) => pkEventComparators[i](oldRow[colIdx], newRow[colIdx]) !== 0);
	}

	/**
	 * Emit the auto data event(s) for one row-level UPDATE under the event contract's split
	 * rule (docs/usage.md § Subscribing to Data Changes): a relocating key change is delivered
	 * as a `delete` at the old key then an `insert` at the new key — so a listener retires the
	 * old identity without having to know which columns form the key — and anything else is a
	 * single `update` keyed by the POST-image, which is the row the table now holds.
	 *
	 * The split loses `changedColumns` and the "same row" link between the two events; that
	 * cost is the documented contract, not an oversight.
	 */
	function emitAutoUpdateEvents(ctx: RuntimeContext, oldRow: Row, newRow: Row): void {
		const newKeyValues = pkColumnIndicesInSchema.map(idx => newRow[idx]);
		if (primaryKeyRelocated(oldRow, newRow)) {
			const oldKeyValues = pkColumnIndicesInSchema.map(idx => oldRow[idx]);
			emitAutoDataEvent(ctx, tableSchema, 'delete', oldKeyValues, [...oldRow]);
			emitAutoDataEvent(ctx, tableSchema, 'insert', newKeyValues, undefined, [...newRow]);
			return;
		}

		const changedColumns: string[] = [];
		for (let i = 0; i < tableSchema.columns.length; i++) {
			if (!sqlValueIdentical(oldRow[i], newRow[i])) {
				changedColumns.push(tableSchema.columns[i].name);
			}
		}
		emitAutoDataEvent(ctx, tableSchema, 'update', newKeyValues, [...oldRow], [...newRow], changedColumns);
	}

	/**
	 * Performs a single row's INSERT side-effects (vtab.update + bookkeeping +
	 * UPSERT handling + REPLACE handling). Returns the row to yield downstream,
	 * or undefined if the row should be skipped (IGNORE / DO NOTHING).
	 *
	 * Throws ConstraintError on violations the executor cannot recover from.
	 */
	async function processInsertRow(
		ctx: RuntimeContext,
		vtab: VirtualTable,
		needsAutoEvents: boolean,
		flatRow: Row,
		contextRow: Row | undefined,
		runtimeUpsertClauses: RuntimeUpsertClause[] | undefined,
		upsertEvaluators: SubProgram[],
		backingConnCache: BackingConnectionCache,
		deferredRebuilds: Set<string>,
		residualBatch: ResidualKeyBatch,
	): Promise<Row | undefined> {
		const newRow = extractNewRowFromFlat(flatRow, tableSchema.columns.length);
		const tableKey = `${tableSchema.schemaName}.${tableSchema.name}`;

		let mutationStatement: string | undefined;
		if (vtab.wantStatements) {
			mutationStatement = buildInsertStatement(tableSchema, newRow, contextRow);
		}

		const args: UpdateArgs = {
			operation: 'insert',
			values: newRow,
			oldKeyValues: undefined,
			// Pass undefined when there's no statement-level OR clause so the vtab
			// can fall back to per-constraint defaultConflict directives. The memory
			// module treats undefined as ABORT when no constraint default is set.
			onConflict: plan.onConflict,
			// The emitters converted the NEW section to declared types up front
			// (emitInsert / constraint-check DEFAULT substitution), so the storage
			// layer must not convert again — JSON conversion is not repeatable.
			preCoerced: true,
			mutationStatement
		};

		if (REPR_STRICT) assertRowConforms(newRow, reprColumnTypes!, reprWhere, reprColumnNames);

		const result = await vtab.update!(args);

		if (isConstraintViolation(result)) {
			if (result.constraint === 'unique' && runtimeUpsertClauses && result.existingRow) {
				const matchingClause = matchUpsertClause(result.existingRow, newRow, runtimeUpsertClauses);
				if (matchingClause) {
					if (matchingClause.action === 'nothing') {
						return undefined;
					}
					const updateResult = await executeUpsertUpdate(
						ctx, vtab, matchingClause, result.existingRow, newRow, contextRow, upsertEvaluators,
					);
					if (!updateResult) return undefined;

					ctx.db._recordUpdate(
						tableKey,
						result.existingRow!,
						updateResult.updatedRow,
						pkColumnIndicesInSchema,
					);
					await maintainRowTimeStructures(ctx, tableKey,
						{ op: 'update', oldRow: result.existingRow!, newRow: updateResult.updatedRow }, backingConnCache, deferredRebuilds, residualBatch);
					await executeForeignKeyActionsAndLens(ctx.db, tableSchema, 'update', result.existingRow!, updateResult.updatedRow, plan.lensRouted);

					if (needsAutoEvents) {
						emitAutoUpdateEvents(ctx, result.existingRow!, updateResult.updatedRow);
					}
					return updateResult.flatRow;
				}
			}
			// No UPSERT clause matched — propagate; caller wraps for FAIL/ROLLBACK.
			throw new ConstraintError(result.message ?? `${result.constraint} constraint failed`, StatusCode.CONSTRAINT);
		}

		// Skip if row was not inserted (e.g., IGNORE mode at vtab level)
		if (!result.row) {
			return undefined;
		}

		// Everything downstream of the write — change tracking, row-time MV
		// maintenance, auto-events, and the row RETURNING projects — must see the
		// row the substrate STORED, not the raw input we handed it. See
		// storedRowOrRaw.
		const numCols = tableSchema.columns.length;
		const storedRow = storedRowOrRaw(result.row, newRow, numCols);

		// Internal REPLACE evictions (rows at OTHER PKs removed to resolve a non-PK
		// UNIQUE conflict) run the full delete pipeline here, before the new row's
		// own bookkeeping — evict-then-write, matching the substrate journal order.
		await processEvictions(ctx, needsAutoEvents, tableKey, result.evictedRows, backingConnCache, deferredRebuilds, residualBatch);

		const replacedRow = result.replacedRow;

		if (replacedRow) {
			ctx.db._recordUpdate(tableKey, replacedRow, storedRow, pkColumnIndicesInSchema);
			await maintainRowTimeStructures(ctx, tableKey, { op: 'update', oldRow: replacedRow, newRow: storedRow }, backingConnCache, deferredRebuilds, residualBatch);
			await executeForeignKeyActionsAndLens(ctx.db, tableSchema, 'delete', replacedRow, undefined, plan.lensRouted);

			if (needsAutoEvents) {
				emitAutoUpdateEvents(ctx, replacedRow, storedRow);
			}
		} else {
			const pkValues = pkColumnIndicesInSchema.map(idx => storedRow[idx]);
			ctx.db._recordInsert(tableKey, storedRow, pkColumnIndicesInSchema);
			await maintainRowTimeStructures(ctx, tableKey, { op: 'insert', newRow: storedRow }, backingConnCache, deferredRebuilds, residualBatch);

			if (needsAutoEvents) {
				emitAutoDataEvent(ctx, tableSchema, 'insert', pkValues, undefined, [...storedRow]);
			}
		}

		return withStoredNewSection(flatRow, storedRow, newRow, numCols);
	}

	/**
	 * Drive the full delete pipeline for every internal REPLACE eviction reported
	 * in `evictedRows` — rows at *other PKs* a substrate removed to resolve a non-PK
	 * UNIQUE conflict for this same `vtab.update()` call. The substrate deletes the
	 * row from its own storage but cannot run the cross-cutting post-write steps
	 * (change-tracking, row-time MV maintenance, FK cascade, auto-events) — those
	 * live solely here. So each evicted row is processed as a full DELETE, exactly
	 * like {@link processDeleteRow}'s own bookkeeping.
	 *
	 * Called *before* the writing row's own insert/update bookkeeping so the
	 * eviction's row-time maintenance and FK cascade land in the substrate's
	 * evict-then-write order (a later same-key backing write must not be undone by
	 * an earlier-PK eviction's delete).
	 */
	async function processEvictions(
		ctx: RuntimeContext,
		needsAutoEvents: boolean,
		tableKey: string,
		evictedRows: readonly Row[] | undefined,
		backingConnCache: BackingConnectionCache,
		deferredRebuilds: Set<string>,
		residualBatch: ResidualKeyBatch,
	): Promise<void> {
		if (!evictedRows || evictedRows.length === 0) return;
		for (const evicted of evictedRows) {
			// RESTRICT / NO ACTION enforcement for the eviction's would-be delete.
			// The substrate already physically removed the evicted row inside
			// vtab.update(), so there is no pre-mutation point. Run the transitive
			// RESTRICT scan post-eviction (the child rows it keys off remain) and,
			// on a violation, throw — runWithStatementSavepoints rolls back the
			// statement savepoint, unwinding both the eviction and the writing row.
			// Mirrors the pre-check processDeleteRow runs for a plain DELETE.
			//
			// lensRouted = false (the default) on both FK calls: an internal REPLACE
			// eviction is a physical basis effect (a row at another PK the substrate
			// removed to resolve a non-PK UNIQUE conflict), not a write through the
			// lens, so it bears only physical (basis-declared) FK semantics.
			await assertTransitiveRestrictsForParentMutation(ctx.db, tableSchema, 'delete', evicted);
			const evictedKeyValues = pkColumnIndicesInSchema.map(idx => evicted[idx]);
			ctx.db._recordDelete(tableKey, evicted, pkColumnIndicesInSchema);
			await maintainRowTimeStructures(ctx, tableKey, { op: 'delete', oldRow: evicted }, backingConnCache, deferredRebuilds, residualBatch);
			await executeForeignKeyActionsAndLens(ctx.db, tableSchema, 'delete', evicted);
			if (needsAutoEvents) {
				emitAutoDataEvent(ctx, tableSchema, 'delete', evictedKeyValues, [...evicted]);
			}
		}
	}

	// UPDATE ----------------------------------------------------
	async function* runUpdate(ctx: RuntimeContext, rows: AsyncIterable<Row>, ...contextEvaluators: Array<(ctx: RuntimeContext) => OutputValue>): AsyncIterable<Row> {
		// Ensure we're in a transaction before any mutations (lazy/JIT transaction start)
		await ctx.db._ensureTransaction();

		const vtab = await getVTable(ctx, tableSchema);
		const needsAutoEvents = ctx.db._needsDataEvents() && !moduleHasNativeDataEvents(ctx, tableSchema);
		const contextRow = await evaluateContextRow(ctx, contextEvaluators);

		// Per-statement backing-connection cache + deferred full-rebuild set + residual
		// key batch (see runInsert).
		const backingConnCache: BackingConnectionCache = new Map();
		const deferredRebuilds = new Set<string>();
		const residualBatch: ResidualKeyBatch = new Map();

		const isFailMode = plan.onConflict === ConflictResolution.FAIL;

		// Batched parent-side RESTRICT enforcement (per-execution state, never on
		// the emit closure — a re-run prepared statement must start empty). When
		// the gate admits the statement, the per-row transitive pre-walk is
		// replaced by key accumulation + one chunked probe per FK at the
		// end-of-statement boundary. The plan side made the same gate decision
		// and skipped the per-row NOT EXISTS checks.
		const batchableFks = getBatchableRestrictFks(
			ctx.db, tableSchema, 'update', plan.onConflict, plan.lensRouted);
		const fkRestrictBatch = batchableFks ? createParentRestrictBatch(batchableFks) : undefined;

		// Physical Halloween avoidance: unless the target module guarantees per-scan
		// snapshot isolation, fully drain the source match set (closing the scan
		// cursor) BEFORE applying any write — otherwise the first UPDATE invalidates
		// the very cursor path the source scan is still walking.
		// NOTE: draining materializes the whole match set; a non-snapshot-isolated
		// `UPDATE big SET ... WHERE rare` matching millions buffers them all. That is
		// the accepted cost of correctness (such a module cannot safely stream-update
		// anyway); memory tables set scanSnapshotIsolation and keep streaming.
		const sourceRows = await resolveDmlSourceRows(ctx, vtab, tableSchema, rows);
		yield* runWithStatementSavepoints(
			ctx, vtab, sourceRows, isFailMode,
			(flatRow) => processUpdateRow(ctx, vtab, needsAutoEvents, flatRow, contextRow, backingConnCache, deferredRebuilds, residualBatch, fkRestrictBatch),
			deferredRebuilds, residualBatch, backingConnCache,
			fkRestrictBatch ? () => flushParentRestrictBatch(ctx.db, tableSchema, 'update', fkRestrictBatch) : undefined,
		);
	}

	/**
	 * Performs a single row's UPDATE side-effects (RESTRICT pre-check +
	 * vtab.update + REPLACE eviction + bookkeeping + FK actions + events).
	 * Returns the row to yield downstream, or undefined if the row was not
	 * updated (row not found). Throws ConstraintError on violations the executor
	 * cannot recover from; the caller (runWithStatementSavepoints) translates it
	 * for FAIL/ROLLBACK modes.
	 */
	async function processUpdateRow(
		ctx: RuntimeContext,
		vtab: VirtualTable,
		needsAutoEvents: boolean,
		flatRow: Row,
		contextRow: Row | undefined,
		backingConnCache: BackingConnectionCache,
		deferredRebuilds: Set<string>,
		residualBatch: ResidualKeyBatch,
		fkRestrictBatch: ParentRestrictBatch | undefined,
	): Promise<Row | undefined> {
		const oldRow = extractOldRowFromFlat(flatRow, tableSchema.columns.length);
		const newRow = extractNewRowFromFlat(flatRow, tableSchema.columns.length);
		const tableKey = `${tableSchema.schemaName}.${tableSchema.name}`;

		// Extract primary key values from the OLD row (these identify which row to update)
		const keyValues: SqlValue[] = pkColumnIndicesInSchema.map(pkColIdx => {
			if (pkColIdx >= oldRow.length) {
				throw new QuereusError(`PK column index ${pkColIdx} out of bounds for OLD row length ${oldRow.length} in UPDATE on '${tableSchema.name}'.`, StatusCode.INTERNAL);
			}
			return oldRow[pkColIdx];
		});

		// Build mutation statement if logging is enabled
		let mutationStatement: string | undefined;
		if (vtab.wantStatements) {
			mutationStatement = buildUpdateStatement(tableSchema, newRow, keyValues, contextRow);
		}

		// Parent-side RESTRICT enforcement. Batched statements accumulate the
		// OLD referenced keys (probed once per FK at the end-of-statement
		// boundary — same pre-vtab observation point per row, so a row the vtab
		// later reports not-found contributes identically to the per-row path).
		// Otherwise: defense-in-depth per-row pre-walk — the plan-time
		// `NOT EXISTS` check is the primary path, but some vtab modules evaluate
		// the embedded subquery differently from a plain row scan. Pre-walk the
		// transitive cascade closure so RESTRICTs at any depth fire BEFORE
		// vtab.update — needed for rowid-mode backends (lamina) where
		// post-mutation OLD-value scans dereference through the just-mutated
		// parent and find zero rows.
		if (fkRestrictBatch) {
			accumulateParentRestrictKeys(fkRestrictBatch, 'update', oldRow, newRow);
		} else {
			await assertTransitiveRestrictsForParentMutation(ctx.db, tableSchema, 'update', oldRow, newRow, plan.lensRouted);
		}

		const args: UpdateArgs = {
			operation: 'update',
			values: newRow,
			oldKeyValues: keyValues,
			// Pass undefined when there's no statement-level OR clause so the vtab
			// can fall back to per-constraint defaultConflict directives. The memory
			// module treats undefined as ABORT when no constraint default is set.
			onConflict: plan.onConflict,
			// emitUpdate converted the NEW section to declared types (assigned
			// columns by static type, unassigned columns are stored values) — the
			// storage layer must not convert again.
			preCoerced: true,
			mutationStatement
		};

		if (REPR_STRICT) assertRowConforms(newRow, reprColumnTypes!, reprWhere, reprColumnNames);

		const result = await vtab.update!(args);

		// Handle constraint violations — caller translates for FAIL/ROLLBACK.
		if (isConstraintViolation(result)) {
			throw new ConstraintError(result.message ?? `${result.constraint} constraint failed`, StatusCode.CONSTRAINT);
		}

		// Skip if row was not updated (row not found returns ok with no row)
		if (!result.row) {
			return undefined;
		}

		// Post-write bookkeeping and the RETURNING row must see the row the
		// substrate STORED, not the raw input — see storedRowOrRaw. `oldRow` came
		// from the source scan, so it is already a stored (coerced) row.
		const numCols = tableSchema.columns.length;
		const storedRow = storedRowOrRaw(result.row, newRow, numCols);

		// If the UPDATE moved this row onto an occupied PK under REPLACE,
		// the vtab returns the displaced row. Surface its deletion BEFORE
		// the move bookkeeping so change tracking, FK cascade, and auto-events
		// see the same evict-then-move sequence the vtab journals (manager.ts
		// records delete(newPk, evicted) before the move). Running the
		// eviction's FK cascade first also avoids ON UPDATE CASCADE pulling
		// children onto PK_new and then having an unrelated ON DELETE CASCADE
		// for the evicted row wipe them out.
		if (result.replacedRow) {
			const evictedKeyValues = pkColumnIndicesInSchema.map(idx => result.replacedRow![idx]);
			ctx.db._recordDelete(
				tableKey,
				result.replacedRow,
				pkColumnIndicesInSchema,
			);
			await maintainRowTimeStructures(ctx, tableKey,
				{ op: 'delete', oldRow: result.replacedRow }, backingConnCache, deferredRebuilds, residualBatch);
			await executeForeignKeyActionsAndLens(ctx.db, tableSchema, 'delete', result.replacedRow, undefined, plan.lensRouted);
			if (needsAutoEvents) {
				emitAutoDataEvent(ctx, tableSchema, 'delete', evictedKeyValues, [...result.replacedRow]);
			}
		}

		// Internal REPLACE evictions (rows at OTHER PKs removed to resolve a non-PK
		// UNIQUE conflict for this same update) run the full delete pipeline here,
		// after any same-PK replacedRow handling and before the moved row's own
		// bookkeeping — evict-then-write, matching the substrate journal order.
		await processEvictions(ctx, needsAutoEvents, tableKey, result.evictedRows, backingConnCache, deferredRebuilds, residualBatch);

		// Track change (UPDATE): pass full rows so the change capture can
		// project the columns any active subscription cares about.
		ctx.db._recordUpdate(
			tableKey,
			oldRow,
			storedRow,
			pkColumnIndicesInSchema,
		);
		await maintainRowTimeStructures(ctx, tableKey,
			{ op: 'update', oldRow, newRow: storedRow }, backingConnCache, deferredRebuilds, residualBatch);

		// Execute FK cascading actions (CASCADE, SET NULL, SET DEFAULT)
		await executeForeignKeyActionsAndLens(ctx.db, tableSchema, 'update', oldRow, storedRow, plan.lensRouted);

		// Emit auto event(s) for modules without native event support. NOT keyed by
		// `keyValues` — that is the vtab's `oldKeyValues` and stays pointed at the OLD row;
		// the event contract keys an update by its post-image and splits a relocating key
		// change into delete + insert. See emitAutoUpdateEvents.
		if (needsAutoEvents) {
			emitAutoUpdateEvents(ctx, oldRow, storedRow);
		}

		return withStoredNewSection(flatRow, storedRow, newRow, numCols);
	}

	// DELETE ----------------------------------------------------
	async function* runDelete(ctx: RuntimeContext, rows: AsyncIterable<Row>, ...contextEvaluators: Array<(ctx: RuntimeContext) => OutputValue>): AsyncIterable<Row> {
		// Ensure we're in a transaction before any mutations (lazy/JIT transaction start)
		await ctx.db._ensureTransaction();

		const vtab = await getVTable(ctx, tableSchema);
		const needsAutoEvents = ctx.db._needsDataEvents() && !moduleHasNativeDataEvents(ctx, tableSchema);
		const contextRow = await evaluateContextRow(ctx, contextEvaluators);

		// Per-statement backing-connection cache + deferred full-rebuild set + residual
		// key batch (see runInsert).
		const backingConnCache: BackingConnectionCache = new Map();
		const deferredRebuilds = new Set<string>();
		const residualBatch: ResidualKeyBatch = new Map();

		const isFailMode = plan.onConflict === ConflictResolution.FAIL;

		// Batched parent-side RESTRICT enforcement — see the matching note in
		// runUpdate (per-execution state; one chunked probe per FK at the
		// end-of-statement boundary when the gate admits the statement).
		const batchableFks = getBatchableRestrictFks(
			ctx.db, tableSchema, 'delete', plan.onConflict, plan.lensRouted);
		const fkRestrictBatch = batchableFks ? createParentRestrictBatch(batchableFks) : undefined;

		// Physical Halloween avoidance — see the matching note in runUpdate. Unless
		// the target module guarantees per-scan snapshot isolation, drain the source
		// match set (closing the scan cursor) before applying any DELETE, so the
		// first delete cannot invalidate the cursor path the scan is still walking.
		const sourceRows = await resolveDmlSourceRows(ctx, vtab, tableSchema, rows);
		yield* runWithStatementSavepoints(
			ctx, vtab, sourceRows, isFailMode,
			(flatRow) => processDeleteRow(ctx, vtab, needsAutoEvents, flatRow, contextRow, backingConnCache, deferredRebuilds, residualBatch, fkRestrictBatch),
			deferredRebuilds, residualBatch, backingConnCache,
			fkRestrictBatch ? () => flushParentRestrictBatch(ctx.db, tableSchema, 'delete', fkRestrictBatch) : undefined,
		);
	}

	/**
	 * Performs a single row's DELETE side-effects (RESTRICT pre-check +
	 * vtab.update + bookkeeping + FK actions + events). Returns the row to yield
	 * downstream, or undefined if the row was not deleted (row not found).
	 * Throws ConstraintError / RESTRICT errors; the caller
	 * (runWithStatementSavepoints) translates constraint violations for
	 * FAIL/ROLLBACK modes.
	 */
	async function processDeleteRow(
		ctx: RuntimeContext,
		vtab: VirtualTable,
		needsAutoEvents: boolean,
		flatRow: Row,
		contextRow: Row | undefined,
		backingConnCache: BackingConnectionCache,
		deferredRebuilds: Set<string>,
		residualBatch: ResidualKeyBatch,
		fkRestrictBatch: ParentRestrictBatch | undefined,
	): Promise<Row | undefined> {
		const oldRow = extractOldRowFromFlat(flatRow, tableSchema.columns.length);
		const tableKey = `${tableSchema.schemaName}.${tableSchema.name}`;

		const keyValues: SqlValue[] = pkColumnIndicesInSchema.map(pkColIdx => {
			if (pkColIdx >= oldRow.length) {
				throw new QuereusError(`PK column index ${pkColIdx} out of bounds for OLD row length ${oldRow.length} in DELETE on '${tableSchema.name}'.`, StatusCode.INTERNAL);
			}
			return oldRow[pkColIdx];
		});

		// Build mutation statement if logging is enabled
		let mutationStatement: string | undefined;
		if (vtab.wantStatements) {
			mutationStatement = buildDeleteStatement(tableSchema, keyValues, contextRow);
		}

		// Parent-side RESTRICT enforcement: batched key accumulation, or the
		// per-row defense-in-depth pre-walk — see comment on the UPDATE path above.
		if (fkRestrictBatch) {
			accumulateParentRestrictKeys(fkRestrictBatch, 'delete', oldRow);
		} else {
			await assertTransitiveRestrictsForParentMutation(ctx.db, tableSchema, 'delete', oldRow, undefined, plan.lensRouted);
		}

		const args: UpdateArgs = {
			operation: 'delete',
			values: undefined,
			oldKeyValues: keyValues,
			onConflict: plan.onConflict ?? ConflictResolution.ABORT,
			// The key cells come from the scanned OLD row — already stored form.
			preCoerced: true,
			mutationStatement
		};

		const result = await vtab.update!(args);

		// Handle constraint violations (unlikely for DELETE, but be consistent).
		if (isConstraintViolation(result)) {
			throw new ConstraintError(result.message ?? `${result.constraint} constraint failed`, StatusCode.CONSTRAINT);
		}

		// Skip if row was not deleted (row not found returns ok with no row)
		if (!result.row) {
			return undefined;
		}

		// Track change (DELETE): record OLD row + PK indices so capture
		// can project the columns subscribers care about.
		ctx.db._recordDelete(
			tableKey,
			oldRow,
			pkColumnIndicesInSchema,
		);
		await maintainRowTimeStructures(ctx, tableKey,
			{ op: 'delete', oldRow }, backingConnCache, deferredRebuilds, residualBatch);

		// Execute FK cascading actions (CASCADE, SET NULL, SET DEFAULT)
		await executeForeignKeyActionsAndLens(ctx.db, tableSchema, 'delete', oldRow, undefined, plan.lensRouted);

		// Emit auto event for modules without native event support
		if (needsAutoEvents) {
			emitAutoDataEvent(ctx, tableSchema, 'delete', keyValues, [...oldRow]);
		}

		return flatRow;
	}

	// Select the correct generator based on operation
	let run: InstructionRun;
	switch (plan.operation) {
		case 'insert': run = asRun(runInsert); break;
		case 'update': run = asRun(runUpdate); break;
		case 'delete': run = asRun(runDelete); break;
		default:
			throw new QuereusError(`Unknown DML operation: ${plan.operation}`, StatusCode.INTERNAL);
	}

	const sourceInstruction = emitPlanNode(plan.source, ctx);

	return {
		params: [sourceInstruction, ...contextEvaluatorInstructions, ...upsertEvaluatorInstructions],
		run,
		note: `execute${plan.operation}(${plan.table.tableSchema.name})`
	};
}
