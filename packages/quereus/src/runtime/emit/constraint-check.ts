import type { ConstraintCheckNode, NotNullDefaultPlan, ConstraintCheck } from '../../planner/nodes/constraint-check-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import type { Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { ConstraintError, FailConflictError, RollbackConflictError } from '../../common/errors.js';
import { type SqlValue, type OutputValue } from '../../common/types.js';
import type { RowConstraintSchema, TableSchema } from '../../schema/table.js';
import type { ColumnSchema } from '../../schema/column.js';
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
	/**
	 * Set when the DEFAULT expression's static type is not the column's declared
	 * type: the substituted value must then be converted before it is written
	 * into the (already-converted) NEW section — the same static-type rule the
	 * DML emitters applied to the rest of the row, which the substitution
	 * bypasses by injecting a value after that pass.
	 */
	coerceColumn?: ColumnSchema;
}

/**
 * The violation message for a failing constraint — single source of truth for the
 * immediate (row-time) and deferred (commit-time) paths, which must report a row
 * identically no matter when the check happened to run.
 *
 * Engine-level CHECK and synthesized FK existence checks share the
 * "CHECK constraint failed" prefix for backward compatibility with existing
 * assertions; downstream consumers identify FK by name. The expression text is
 * appended as a hint only when short enough to stay readable.
 */
function constraintViolationMessage(metadata: ConstraintMetadataEntry): string {
	const exprHint = metadata.constraintExpr.length <= 60 ? ` (${metadata.constraintExpr})` : '';
	return `CHECK constraint failed: ${metadata.constraintName}${exprHint}`;
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
			// NOTE: a declared context var with no supplied value is silently skipped here,
			// which would shift every later value out of alignment with contextDescriptor.
			// Unreachable today — emitDmlExecutor throws "Missing mutation context value for
			// '<name>'" at prepare time first — but that's an external invariant, not one
			// this loop enforces itself.
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

	// Which substitutions need conversion — the emitters' static-type rule
	// applied to the DEFAULT expression (see NotNullDefaultRuntime.coerceColumn).
	const notNullDefaultCoercions = notNullDefaultPlans.map(d =>
		d.defaultNode.getType().logicalType !== tableSchema.columns[d.columnIndex].logicalType
			? tableSchema.columns[d.columnIndex]
			: undefined);

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
			coerceColumn: notNullDefaultCoercions[i],
		}));

		// Pre-compute the combined descriptor (constant across rows)
		const combinedDescriptor = contextDescriptor && contextRow
			? composeCombinedDescriptor(contextDescriptor, flatRowDescriptor)
			: flatRowDescriptor;

		try {
			for await (const inputRow of inputRows) {
				let flatRow = inputRow;

				// The row expressions see through `combinedDescriptor`. The getter is
				// called lazily per lookup, so checkConstraints can swap it mid-row:
				// after a REPLACE NOT NULL DEFAULT substitution, CHECK / FK must read
				// the row AS SUBSTITUTED. The row arrives already converted to declared
				// column types (the DML emitters convert the NEW section up front), so
				// no separate coerced view exists — the substituted row IS what flows
				// downstream.
				let visibleRow: Row = flatRow;

				const evaluation = await withAsyncRowContext(
					rctx,
					combinedDescriptor,
					() => contextRow ? [...contextRow, ...visibleRow] : visibleRow,
					() => checkConstraints(
						rctx,
						plan,
						tableSchema,
						flatRow,
						constraintMetadata,
						constraintEvalFunctions,
						stmtOR,
						defaultsRuntime,
						row => { visibleRow = row; },
					),
				);

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
	showRow: (row: Row) => void,
): Promise<ConstraintCheckResult> {
	// The row arrives with its NEW section already converted to declared column
	// types (the DML emitters convert up front, driven by static types), so both
	// passes read declared-form values. NOT NULL runs first: under OR REPLACE it
	// may substitute a column's DEFAULT (converting that one injected value —
	// see NotNullDefaultRuntime.coerceColumn), and CHECK / FK then read the row
	// AS FINALLY SUBSTITUTED, which is also what flows on downstream.
	const nnResult = await checkNotNullConstraints(rctx, plan, tableSchema, row, stmtOR, notNullDefaults);
	if (nnResult.skip) return { skip: true };
	if (nnResult.replacedRow) row = nnResult.replacedRow;

	showRow(row);

	// CHECK constraints (and synthetic FK existence checks built as RowConstraintSchema).
	const ckResult = await checkCheckConstraints(rctx, plan, tableSchema, constraintMetadata, evaluatorFunctions, stmtOR, row);
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
			let defaultValue = await defaultEntry.evaluator(rctx) as SqlValue;
			if (defaultValue === null || defaultValue === undefined) {
				// DEFAULT itself is NULL — substitution does not satisfy NOT NULL.
				throw new ConstraintError(message);
			}
			if (defaultEntry.coerceColumn) {
				// The substituted value is injected AFTER the emitters' conversion
				// pass, so convert it here by the same static-type rule. Conversion
				// itself can produce NULL (JSON's text 'null'), which still violates
				// NOT NULL.
				defaultValue = validateAndParse(
					defaultValue, defaultEntry.coerceColumn.logicalType, defaultEntry.coerceColumn.name);
				if (defaultValue === null) {
					throw new ConstraintError(message);
				}
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
	constraintMetadata: ConstraintMetadataEntry[],
	evaluatorFunctions: Array<(ctx: RuntimeContext) => OutputValue>,
	stmtOR: ConflictResolution | undefined,
	flatRow: Row,
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
			// Both halves are in stored (declared) form: OLD comes from the scan, NEW
			// was converted by the DML emitter — so plain identity is the right test.
			const numCols = tableSchema.columns.length;
			let anyChanged = false;
			for (const colIdx of metadata.referencedColumnIndices) {
				const oldVal = flatRow[colIdx] as SqlValue;           // OLD section: 0..n-1
				const newVal = flatRow[numCols + colIdx] as SqlValue; // NEW section: n..2n-1
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
			// Wrap so the deferred queue's evaluation at COMMIT throws the same
			// attributed message as the immediate path below, instead of the queue's
			// generic name-only fallback — matches the pattern derived-row-validator.ts
			// already uses for maintained tables. The wrapper always throws before
			// returning falsy, so the queue's own generic message never fires here.
			// Only ABORT reaches this branch (see mustEvaluateNow), so throwing is the
			// whole of the deferred failure contract — no IGNORE/REPLACE leg needed.
			const message = constraintViolationMessage(metadata);
			const deferredEvaluator = async (dctx: RuntimeContext): Promise<SqlValue> => {
				const rawResult = evaluator(dctx);
				const result = (rawResult instanceof Promise ? await rawResult : rawResult) as SqlValue;
				if (result !== null && !isTruthy(result)) {
					throw new ConstraintError(message);
				}
				return result;
			};
			rctx.db._queueDeferredConstraintRow(
				metadata.baseTable,
				metadata.constraintName,
				flatRow,
				metadata.flatRowDescriptor,
				deferredEvaluator,
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
			const baseMessage = constraintViolationMessage(metadata);

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

function generateDefaultConstraintName(tableSchema: TableSchema, constraint: RowConstraintSchema): string {
	// Find the index of this constraint in the original array to get the correct constraint number
	const originalIndex = tableSchema.checkConstraints.findIndex((c: RowConstraintSchema) => c === constraint);
	return `_check_${originalIndex >= 0 ? originalIndex : 'unknown'}`;
}

