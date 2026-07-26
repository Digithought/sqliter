import type { ConstraintCheckNode, NotNullDefaultPlan, ConstraintCheck } from '../../planner/nodes/constraint-check-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import type { Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { ConstraintError, FailConflictError, RollbackConflictError } from '../../common/errors.js';
import { type SqlValue, type OutputValue } from '../../common/types.js';
import type { RowConstraintSchema, TableSchema } from '../../schema/table.js';
import type { RowDescriptor } from '../../planner/nodes/plan-node.js';
import { RowOpFlag } from '../../schema/table.js';
import { ConflictResolution } from '../../common/constants.js';
import { withAsyncRowContext, createRowSlot } from '../context-helpers.js';
import { expressionToString } from '../../emit/ast-stringify.js';
import { composeCombinedDescriptor } from '../descriptor-helpers.js';
import { sqlValueIdentical, isTruthy } from '../../util/comparison.js';
import { validateAndParse } from '../../types/validation.js';

interface ConstraintMetadataEntry {
	schema: RowConstraintSchema;
	flatRowDescriptor: RowDescriptor;
	evaluator: (ctx: RuntimeContext) => OutputValue;
	constraintName: string;
	constraintExpr: string; // Stringified constraint expression
	shouldDefer: boolean;
	baseTable: string;
	contextRow?: Row; // Mutation context row if present
	contextDescriptor?: RowDescriptor; // Mutation context row descriptor
	kind: 'check' | 'fk-child' | 'fk-parent';
	/** For 'fk-parent' UPDATE checks: parent-table column indices the FK references. */
	referencedColumnIndices?: ReadonlyArray<number>;
}

interface NotNullDefaultRuntime {
	columnIndex: number;
	evaluator: (ctx: RuntimeContext) => OutputValue;
}

/**
 * Resolve the effective conflict action for a single failure.
 *
 * Precedence: statement-level OR clause > per-constraint default > ABORT.
 */
function pickAction(
	stmtOR: ConflictResolution | undefined,
	constraintDefault: ConflictResolution | undefined,
): ConflictResolution {
	return stmtOR ?? constraintDefault ?? ConflictResolution.ABORT;
}

/**
 * Throws an appropriate ConstraintError subclass based on the effective
 * conflict action. ABORT/REPLACE/IGNORE callers must not reach this — IGNORE
 * is handled by skipping the row, REPLACE by substitution / passthrough, and
 * ABORT throws a plain ConstraintError.
 */
function throwForAction(action: ConflictResolution, message: string): never {
	if (action === ConflictResolution.FAIL) {
		throw new FailConflictError(message);
	}
	if (action === ConflictResolution.ROLLBACK) {
		throw new RollbackConflictError(message);
	}
	throw new ConstraintError(message);
}

export function emitConstraintCheck(plan: ConstraintCheckNode, ctx: EmissionContext): Instruction {
	// Get the table schema to access constraints
	const tableSchema = plan.table.tableSchema;

	// Use the pre-built flat row descriptor from the plan
	const flatRowDescriptor = plan.flatRowDescriptor;

	// Get mutation context from the plan (passed from DML builders)
	const mutationContextValues = plan.mutationContextValues;
	const contextAttributes = plan.contextAttributes;
	const contextDescriptor = plan.contextDescriptor;
	const stmtOR = plan.onConflict;

	// Emit mutation context value evaluators if present
	const contextEvaluatorInstructions: Instruction[] = [];
	if (mutationContextValues && contextAttributes) {
		for (const attr of contextAttributes) {
			const valueExpr = mutationContextValues.get(attr.name);
			if (valueExpr) {
				contextEvaluatorInstructions.push(emitCallFromPlan(valueExpr, ctx));
			}
		}
	}

	// Emit evaluator instructions for each pre-built constraint expression
	const checkEvaluators = plan.constraintChecks.map(check =>
		emitCallFromPlan(check.expression, ctx)
	);

	// Emit evaluators for NOT NULL DEFAULT substitution (used by REPLACE).
	const notNullDefaultPlans: ReadonlyArray<NotNullDefaultPlan> = plan.notNullDefaults ?? [];
	const notNullDefaultInstructions = notNullDefaultPlans.map(d => emitCallFromPlan(d.defaultNode, ctx));

	const constraintMetadata: ConstraintMetadataEntry[] = plan.constraintChecks.map((check: ConstraintCheck, idx) => {
		const evaluatorInstruction = checkEvaluators[idx];
		const constraintName = check.constraint.name ?? generateDefaultConstraintName(tableSchema, check.constraint);
		const constraintExpr = expressionToString(check.constraint.expr);
		return {
			schema: check.constraint,
			flatRowDescriptor: plan.flatRowDescriptor,
			evaluator: evaluatorInstruction.run,
			constraintName,
			constraintExpr,
			shouldDefer: Boolean(check.deferrable || check.initiallyDeferred || check.needsDeferred),
			baseTable: `${tableSchema.schemaName}.${tableSchema.name}`,
			contextRow: undefined,
			contextDescriptor,
			kind: check.kind ?? 'check',
			referencedColumnIndices: check.referencedColumnIndices,
		};
	});

	// Constant per plan: whether any CHECK / FK expression will read the row.
	const hasConstraintExprs = constraintMetadata.length > 0;

	async function* run(rctx: RuntimeContext, inputRows: AsyncIterable<Row>, ...evaluatorFunctions: Array<(ctx: RuntimeContext) => OutputValue>): AsyncIterable<Row> {
		if (!inputRows) {
			return;
		}

		// Split: first contextEvaluatorInstructions are context evaluators, then constraint
		// evaluators, then NOT NULL DEFAULT evaluators.
		const numContextEvaluators = contextEvaluatorInstructions.length;
		const numConstraintEvaluators = constraintMetadata.length;

		let contextRow: Row | undefined;
		let contextSlot: ReturnType<typeof createRowSlot> | undefined;

		if (numContextEvaluators > 0 && contextDescriptor) {
			const contextEvalFunctions = evaluatorFunctions.slice(0, numContextEvaluators);

			contextRow = [];
			for (const contextEvaluator of contextEvalFunctions) {
				// Resolve without a per-row microtask hop: `await` only when the
				// sub-program is genuinely a promise. See runtime/async-util.ts.
				const raw = contextEvaluator(rctx);
				const value = (raw instanceof Promise ? await raw : raw) as SqlValue;
				contextRow.push(value);
			}

			constraintMetadata.forEach(meta => {
				meta.contextRow = contextRow;
			});

			contextSlot = createRowSlot(rctx, contextDescriptor);
			contextSlot.set(contextRow);
		}

		const constraintEvalFunctions = evaluatorFunctions.slice(
			numContextEvaluators,
			numContextEvaluators + numConstraintEvaluators,
		);
		const defaultEvalFunctions = evaluatorFunctions.slice(numContextEvaluators + numConstraintEvaluators);

		const defaultsRuntime: NotNullDefaultRuntime[] = notNullDefaultPlans.map((d, i) => ({
			columnIndex: d.columnIndex,
			evaluator: defaultEvalFunctions[i],
		}));

		// Pre-compute the combined descriptor (constant across rows)
		const combinedDescriptor = contextDescriptor && contextRow
			? composeCombinedDescriptor(contextDescriptor, flatRowDescriptor)
			: flatRowDescriptor;

		try {
			for await (const inputRow of inputRows) {
				let flatRow = inputRow;

				// Constraint expressions read the row through this context, so they see
				// the COERCED NEW section — the same canonical values a later `select`
				// reads back. `flatRow` itself stays raw and is what flows downstream:
				// the storage layer coerces it on its own, and JSON's `parse` is not
				// idempotent for a JSON string scalar, so a pre-coerced row must never
				// reach it. See coerceNewSection.
				//
				// Only the CHECK / FK expressions read this view, and the DML builders
				// emit a ConstraintCheckNode for EVERY table, so skip the copy when there
				// are none — NOT NULL reads the raw row, and coercion cannot change
				// whether a value is NULL.
				//
				// NOTE: for a table that does carry checks this copies the flat row and
				// runs validateAndParse over every column, once per row (replacing the
				// previous per-deferred-constraint recompute). If constraint-heavy insert
				// throughput ever shows as hot, narrow it to the columns the constraint
				// expressions actually reference.
				const coercedRow = hasConstraintExprs ? coerceNewSection(flatRow, tableSchema) : flatRow;

				const evaluation = await withAsyncRowContext(rctx, combinedDescriptor, () => contextRow ? [...contextRow, ...coercedRow] : coercedRow, async () => {
					return await checkConstraints(
						rctx,
						plan,
						tableSchema,
						flatRow,
						constraintMetadata,
						constraintEvalFunctions,
						stmtOR,
						defaultsRuntime,
						coercedRow,
					);
				});

				if (evaluation.skip) continue;
				if (evaluation.replacedRow) {
					flatRow = evaluation.replacedRow;
				}

				yield flatRow;
			}
		} finally {
			if (contextSlot) {
				contextSlot.close();
			}
		}
	}

	// Emit the source instruction
	const sourceInstruction = emitPlanNode(plan.source, ctx);

	return {
		params: [sourceInstruction, ...contextEvaluatorInstructions, ...checkEvaluators, ...notNullDefaultInstructions],
		run: asRun(run),
		note: `constraintCheck(${plan.operation}, ${contextEvaluatorInstructions.length} ctx, ${plan.constraintChecks.length} checks, ${notNullDefaultInstructions.length} defaults)`
	};
}

/**
 * Result of evaluating constraints for a single row.
 *
 * - skip=true → caller should drop this row (IGNORE resolution)
 * - replacedRow → caller should yield this row instead of the input (REPLACE
 *   substituted a DEFAULT for a NOT NULL violation)
 */
interface ConstraintCheckResult {
	skip: boolean;
	replacedRow?: Row;
}

async function checkConstraints(
	rctx: RuntimeContext,
	plan: ConstraintCheckNode,
	tableSchema: TableSchema,
	row: Row,
	constraintMetadata: ConstraintMetadataEntry[],
	evaluatorFunctions: Array<(ctx: RuntimeContext) => OutputValue>,
	stmtOR: ConflictResolution | undefined,
	notNullDefaults: NotNullDefaultRuntime[],
	coercedRow: Row,
): Promise<ConstraintCheckResult> {
	// NOT NULL constraints with possible REPLACE-DEFAULT substitution.
	const nnResult = await checkNotNullConstraints(rctx, plan, tableSchema, row, stmtOR, notNullDefaults);
	if (nnResult.skip) return { skip: true };
	if (nnResult.replacedRow) {
		// A REPLACE-substituted DEFAULT changed the NEW section, so the pre-computed
		// coerced view is stale — rebuild it for the deferred snapshot below.
		row = nnResult.replacedRow;
		coercedRow = constraintMetadata.length > 0 ? coerceNewSection(row, tableSchema) : row;
	}

	// CHECK constraints (and synthetic FK existence checks built as RowConstraintSchema).
	const ckResult = await checkCheckConstraints(rctx, plan, tableSchema, row, constraintMetadata, evaluatorFunctions, stmtOR, coercedRow);
	if (ckResult.skip) return { skip: true };

	return { skip: false, replacedRow: nnResult.replacedRow };
}

async function checkNotNullConstraints(
	rctx: RuntimeContext,
	plan: ConstraintCheckNode,
	tableSchema: TableSchema,
	flatRow: Row,
	stmtOR: ConflictResolution | undefined,
	notNullDefaults: NotNullDefaultRuntime[],
): Promise<ConstraintCheckResult> {
	if (plan.operation === RowOpFlag.DELETE) {
		return { skip: false };
	}

	if (!plan.newRowDescriptor) {
		return { skip: false };
	}

	const numCols = tableSchema.columns.length;
	let mutableRow: Row | undefined;

	// NOT NULL attribution: report the FIRST NOT-NULL column (in declaration
	// order) whose effective NEW value is NULL, naming that column itself —
	// independent of which column any DEFAULT references. A NULL sibling named by
	// another column's `new.<col>` DEFAULT violates its OWN NOT NULL and is
	// reported on its own merits, never threaded into the defaulted column's
	// message. (See test/logic/03.4-defaults.sqllogic, the NOT NULL default section.)
	for (let i = 0; i < numCols; i++) {
		const column = tableSchema.columns[i];
		if (!column.notNull) continue;

		const newValueIndex = numCols + i; // NEW section: n..2n-1
		const value = (mutableRow ?? flatRow)[newValueIndex];
		if (value !== null && value !== undefined) continue;

		const action = pickAction(stmtOR, column.defaultConflict);
		const message = `NOT NULL constraint failed: ${tableSchema.name}.${column.name}`;

		if (action === ConflictResolution.IGNORE) {
			return { skip: true };
		}

		if (action === ConflictResolution.REPLACE) {
			// Try to substitute the column's DEFAULT.
			const defaultEntry = notNullDefaults.find(d => d.columnIndex === i);
			if (!defaultEntry) {
				// No DEFAULT available — REPLACE cannot recover.
				throw new ConstraintError(message);
			}
			const defaultValue = await defaultEntry.evaluator(rctx) as SqlValue;
			if (defaultValue === null || defaultValue === undefined) {
				// DEFAULT itself is NULL — substitution does not satisfy NOT NULL.
				throw new ConstraintError(message);
			}
			if (!mutableRow) mutableRow = [...flatRow] as Row;
			mutableRow[newValueIndex] = defaultValue;
			continue;
		}

		// ABORT / FAIL / ROLLBACK
		throwForAction(action, message);
	}

	return { skip: false, replacedRow: mutableRow };
}

async function checkCheckConstraints(
	rctx: RuntimeContext,
	plan: ConstraintCheckNode,
	tableSchema: TableSchema,
	row: Row,
	constraintMetadata: ConstraintMetadataEntry[],
	evaluatorFunctions: Array<(ctx: RuntimeContext) => OutputValue>,
	stmtOR: ConflictResolution | undefined,
	coercedRow: Row,
): Promise<ConstraintCheckResult> {
	for (let i = 0; i < constraintMetadata.length; i++) {
		const metadata = constraintMetadata[i];
		const evaluator = evaluatorFunctions[i] ?? metadata.evaluator;

		// Trust-the-origin apply path: the synthesized parent-side FK RESTRICT (NOT EXISTS)
		// check is the plan-time dual of the runtime RESTRICT pre-checks. While applying
		// external row changes the receiver skips it (the origin already enforced RESTRICT at
		// its own commit) - otherwise a cascade DML re-entering this executor under the apply
		// flag would throw here, wedging the sync stream. Only 'fk-parent' checks are gated;
		// user CHECKs and child-side FK existence checks are untouched.
		// (See database-external-changes.ts and runtime/foreign-key-actions.ts for the runtime dual.)
		if (metadata.kind === 'fk-parent' && rctx.db._isFkRestrictSuppressed()) continue;

		// Parent-side FK UPDATE: skip the NOT EXISTS subquery when none of the
		// referenced parent columns actually changed.
		if (
			plan.operation === RowOpFlag.UPDATE &&
			metadata.kind === 'fk-parent' &&
			metadata.referencedColumnIndices
		) {
			const numCols = tableSchema.columns.length;
			let anyChanged = false;
			for (const colIdx of metadata.referencedColumnIndices) {
				const oldVal = row[colIdx] as SqlValue;           // OLD section: 0..n-1
				const newVal = row[numCols + colIdx] as SqlValue; // NEW section: n..2n-1
				if (!sqlValueIdentical(oldVal, newVal)) {
					anyChanged = true;
					break;
				}
			}
			if (!anyChanged) continue;
		}

		// Resolve effective action up front; non-default actions (IGNORE/REPLACE/FAIL/ROLLBACK)
		// must be applied at row time, so we cannot let those defer to commit.
		const effectiveAction = pickAction(stmtOR, metadata.schema.defaultConflict);
		const mustEvaluateNow = effectiveAction !== ConflictResolution.ABORT;

		if (metadata.shouldDefer && !mustEvaluateNow) {
			const activeConnectionId = rctx.activeConnection?.connectionId;
			rctx.db._queueDeferredConstraintRow(
				metadata.baseTable,
				metadata.constraintName,
				coercedRow,
				metadata.flatRowDescriptor,
				evaluator,
				activeConnectionId,
				metadata.contextRow,
				metadata.contextDescriptor
			);
			continue;
		}

		// Resolve without a per-row microtask hop (see runtime/async-util.ts).
		const rawResult = evaluator(rctx);
		const result = (rawResult instanceof Promise ? await rawResult : rawResult) as SqlValue;

		// CHECK passes if truthy or NULL; fails otherwise (shared isTruthy semantics).
		if (result !== null && !isTruthy(result)) {
			const exprHint = metadata.constraintExpr.length <= 60
				? ` (${metadata.constraintExpr})`
				: '';
			// Both engine-level CHECK and synthetic FK existence checks share the
			// same "CHECK constraint failed" prefix for backward compatibility with
			// existing assertions; downstream consumers identify FK by name.
			const baseMessage = `CHECK constraint failed: ${metadata.constraintName}${exprHint}`;

			if (effectiveAction === ConflictResolution.IGNORE) {
				return { skip: true };
			}

			// REPLACE does NOT mask CHECK / FK violations — fall through to abort.
			// (SQLite's OR REPLACE only relaxes UNIQUE/PK and NOT-NULL; CHECK still aborts.)
			if (effectiveAction === ConflictResolution.REPLACE) {
				throw new ConstraintError(baseMessage);
			}

			throwForAction(effectiveAction, baseMessage);
		}
	}
	return { skip: false };
}

/**
 * Snapshot the flat OLD/NEW row for constraint evaluation, coercing the NEW
 * section (indices n..2n-1) to the declared column logical types.
 *
 * The insert pipeline defers type conversion to the storage layer's
 * validateAndParse, so the row reaching this node still holds raw NEW values —
 * an unconverted `'{"a":2}'` straight from the SQL literal, not the parsed JSON
 * value a `select` would read back. Every constraint expression must see the
 * converted form, or it compares apples to oranges:
 *
 * - Deferred CHECK subqueries compare NEW against already-coerced stored rows in
 *   other tables (GitHub #25).
 * - Immediate CHECKs compare NEW against NEW; two raw JSON texts would compare
 *   as text — `'{"a":10}' < '{"a":2}'` alphabetically — instead of structurally
 *   (fix `bug-json-compare-string-ambiguity`).
 *
 * The result is used ONLY for constraint evaluation. The raw row is what flows
 * downstream to the storage layer, which coerces it itself; JSON's `parse` is not
 * idempotent for a JSON string scalar (`'"Bob"'` parses to the bare string `Bob`,
 * and re-parsing that throws), so a pre-coerced row must never reach it.
 *
 * OLD values (0..n-1) are NULL on INSERT or read from already-coerced stored
 * rows on UPDATE, so they are left untouched. A per-cell parse failure falls
 * back to the raw value, preserving the existing error semantics — the row's
 * own performInsert remains the authoritative place that throws MISMATCH.
 */
function coerceNewSection(row: Row, tableSchema: TableSchema): Row {
	const numCols = tableSchema.columns.length;
	const snapshot = row.slice() as Row;
	for (let i = 0; i < numCols; i++) {
		const newIndex = numCols + i;
		if (newIndex >= snapshot.length) break;
		const column = tableSchema.columns[i];
		const value = snapshot[newIndex] as SqlValue;
		try {
			snapshot[newIndex] = validateAndParse(value, column.logicalType, column.name);
		} catch {
			// Keep the raw value; downstream performInsert reports the error as today.
		}
	}
	return snapshot;
}

function generateDefaultConstraintName(tableSchema: TableSchema, constraint: RowConstraintSchema): string {
	// Find the index of this constraint in the original array to get the correct constraint number
	const originalIndex = tableSchema.checkConstraints.findIndex((c: RowConstraintSchema) => c === constraint);
	return `_check_${originalIndex >= 0 ? originalIndex : 'unknown'}`;
}

