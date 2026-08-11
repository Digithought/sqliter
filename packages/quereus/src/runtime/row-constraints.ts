import type { ConstraintCheck } from '../planner/nodes/constraint-check-node.js';
import type { RuntimeContext } from './types.js';
import type { Row, SqlValue, OutputValue } from '../common/types.js';
import { ConstraintError, FailConflictError, RollbackConflictError } from '../common/errors.js';
import type { RowConstraintSchema, TableSchema } from '../schema/table.js';
import type { ColumnSchema } from '../schema/column.js';
import type { RowDescriptor } from '../planner/nodes/plan-node.js';
import { RowOpFlag } from '../schema/table.js';
import { ConflictResolution } from '../common/constants.js';
import { expressionToString } from '../emit/ast-stringify.js';
import { sqlValueIdentical, isTruthy } from '../util/comparison.js';
import { validateAndParse } from '../types/validation.js';

/**
 * Row validation shared by every site that must enforce a table's CHECK / NOT NULL /
 * synthesized FK-existence constraints against one flat OLD|NEW row.
 *
 * Two callers today:
 * - `emit/constraint-check.ts` — the `ConstraintCheckNode` in a DML plan, which is
 *   where ordinary INSERT / UPDATE / DELETE rows are validated;
 * - `emit/dml-executor.ts` — the `on conflict … do update` arm, which composes the
 *   row it writes *inside* the executor and so can never reach that node.
 *
 * Nothing here knows about plan nodes: the two row-shape facts the algorithm needs
 * are passed as a {@link RowConstraintScope}.
 */

/** The row-shape facts the evaluator needs, independent of which plan node supplied them. */
export interface RowConstraintScope {
	operation: RowOpFlag;
	/** True when the flat row carries a NEW section (false for a DELETE-shaped set). */
	hasNewSection: boolean;
}

export interface ConstraintMetadataEntry {
	schema: RowConstraintSchema;
	flatRowDescriptor: RowDescriptor;
	evaluator: (ctx: RuntimeContext) => OutputValue;
	constraintName: string;
	constraintExpr: string; // Stringified constraint expression
	shouldDefer: boolean;
	baseTable: string;
	contextDescriptor?: RowDescriptor; // Mutation context row descriptor
	kind: 'check' | 'fk-child' | 'fk-parent';
	/** For 'fk-parent' UPDATE checks: parent-table column indices the FK references. */
	referencedColumnIndices?: ReadonlyArray<number>;
	/** Verbatim violation text carried from a synthesized {@link ConstraintCheck}
	 *  (see {@link constraintViolationMessage}). */
	violationMessage?: string;
	/** Carried from {@link ConstraintCheck.messageValued}: the expression yields NULL when
	 *  satisfied and the violation message when violated (see {@link constraintFailed}). */
	messageValued?: boolean;
}

export interface NotNullDefaultRuntime {
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
 * Result of evaluating constraints for a single row.
 *
 * - skip=true → caller should drop this row (IGNORE resolution)
 * - replacedRow → caller should use this row instead of the input (REPLACE
 *   substituted a DEFAULT for a NOT NULL violation)
 */
export interface RowConstraintResult {
	skip: boolean;
	replacedRow?: Row;
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
 *
 * A synthesized check may override the whole text via `violationMessage` — the
 * expression hint is engine-authored there, so quoting it back at the user
 * explains nothing (see the absent-parent branch of `buildChildSideFKChecks`).
 * Overrides keep the shared prefix themselves.
 *
 * A **message-valued** constraint (see {@link ConstraintMetadataEntry.messageValued})
 * computed its own message as its evaluation result — `value` is that result,
 * reported verbatim. The synthesizer bakes the per-rule text (each carrying the
 * appropriate class prefix) into the expression, so nothing is derived here.
 */
function constraintViolationMessage(metadata: ConstraintMetadataEntry, value?: SqlValue): string {
	if (metadata.messageValued && value !== null && value !== undefined) return String(value);
	if (metadata.violationMessage) return metadata.violationMessage;
	const exprHint = metadata.constraintExpr.length <= 60 ? ` (${metadata.constraintExpr})` : '';
	return `CHECK constraint failed: ${metadata.constraintName}${exprHint}`;
}

/**
 * Whether an evaluated constraint value is a violation. An ordinary CHECK
 * passes if truthy or NULL (shared isTruthy semantics); a message-valued
 * constraint inverts the test — it evaluates to NULL when satisfied and to the
 * (non-NULL) violation message when violated.
 */
function constraintFailed(metadata: ConstraintMetadataEntry, result: SqlValue): boolean {
	return metadata.messageValued
		? result !== null && result !== undefined
		: result !== null && !isTruthy(result);
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

function generateDefaultConstraintName(tableSchema: TableSchema, constraint: RowConstraintSchema): string {
	// Find the index of this constraint in the original array to get the correct constraint number
	const originalIndex = tableSchema.checkConstraints.findIndex((c: RowConstraintSchema) => c === constraint);
	return `_check_${originalIndex >= 0 ? originalIndex : 'unknown'}`;
}

/**
 * Build the per-check metadata the evaluator reads, once at emit time.
 *
 * `evaluators` are the emitted instructions' own `run` functions, index-aligned
 * with `checks`; they are the fallback the evaluator uses when the scheduler did
 * not supply a resolved function for that position.
 */
export function buildConstraintMetadata(
	checks: readonly ConstraintCheck[],
	tableSchema: TableSchema,
	flatRowDescriptor: RowDescriptor,
	contextDescriptor: RowDescriptor | undefined,
	evaluators: ReadonlyArray<(ctx: RuntimeContext) => OutputValue>,
): ConstraintMetadataEntry[] {
	return checks.map((check, idx) => ({
		schema: check.constraint,
		flatRowDescriptor,
		evaluator: evaluators[idx],
		constraintName: check.constraint.name ?? generateDefaultConstraintName(tableSchema, check.constraint),
		constraintExpr: expressionToString(check.constraint.expr),
		shouldDefer: Boolean(check.deferrable || check.initiallyDeferred || check.needsDeferred),
		baseTable: `${tableSchema.schemaName}.${tableSchema.name}`,
		contextDescriptor,
		kind: check.kind ?? 'check',
		referencedColumnIndices: check.referencedColumnIndices,
		violationMessage: check.violationMessage,
		messageValued: check.messageValued,
	}));
}

/**
 * Validate one flat OLD|NEW row against the table's NOT NULL columns and the
 * pre-built CHECK / FK-existence checks.
 *
 * The caller must already have bound the row (composed with the mutation-context
 * row when present) into the runtime context — the check expressions resolve
 * their column references through it.
 *
 * `showRow` is invoked with the row as finally substituted, so a caller whose
 * binding is a lazy getter can swap what the CHECK / FK expressions read after a
 * REPLACE NOT NULL DEFAULT substitution.
 */
export async function evaluateRowConstraints(
	rctx: RuntimeContext,
	scope: RowConstraintScope,
	tableSchema: TableSchema,
	flatRow: Row,
	metadata: ConstraintMetadataEntry[],
	evaluators: Array<(ctx: RuntimeContext) => OutputValue>,
	stmtOR: ConflictResolution | undefined,
	notNullDefaults: NotNullDefaultRuntime[],
	contextRow: Row | undefined,
	showRow: (row: Row) => void,
): Promise<RowConstraintResult> {
	// The row arrives with its NEW section already converted to declared column
	// types (the DML emitters convert up front, driven by static types), so both
	// passes read declared-form values. NOT NULL runs first: under OR REPLACE it
	// may substitute a column's DEFAULT (converting that one injected value —
	// see NotNullDefaultRuntime.coerceColumn), and CHECK / FK then read the row
	// AS FINALLY SUBSTITUTED, which is also what flows on downstream.
	let row = flatRow;
	const nnResult = await checkNotNullConstraints(rctx, scope, tableSchema, row, stmtOR, notNullDefaults);
	if (nnResult.skip) return { skip: true };
	if (nnResult.replacedRow) row = nnResult.replacedRow;

	showRow(row);

	// CHECK constraints (and synthetic FK existence checks built as RowConstraintSchema).
	const ckResult = await checkCheckConstraints(rctx, scope, tableSchema, metadata, evaluators, stmtOR, row, contextRow);
	if (ckResult.skip) return { skip: true };

	return { skip: false, replacedRow: nnResult.replacedRow };
}

async function checkNotNullConstraints(
	rctx: RuntimeContext,
	scope: RowConstraintScope,
	tableSchema: TableSchema,
	flatRow: Row,
	stmtOR: ConflictResolution | undefined,
	notNullDefaults: NotNullDefaultRuntime[],
): Promise<RowConstraintResult> {
	if (scope.operation === RowOpFlag.DELETE) {
		return { skip: false };
	}

	if (!scope.hasNewSection) {
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
	scope: RowConstraintScope,
	tableSchema: TableSchema,
	constraintMetadata: ConstraintMetadataEntry[],
	evaluatorFunctions: Array<(ctx: RuntimeContext) => OutputValue>,
	stmtOR: ConflictResolution | undefined,
	flatRow: Row,
	contextRow: Row | undefined,
): Promise<RowConstraintResult> {
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
			scope.operation === RowOpFlag.UPDATE &&
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
			// returning a failing value, so the queue's own generic message never fires
			// here (a message-valued pass IS NULL, which the queue treats as a pass).
			// Only ABORT reaches this branch (see mustEvaluateNow), so throwing is the
			// whole of the deferred failure contract — no IGNORE/REPLACE leg needed.
			// The message is computed at evaluation time: a message-valued constraint's
			// message IS its evaluated value, unknowable before commit.
			const deferredEvaluator = async (dctx: RuntimeContext): Promise<SqlValue> => {
				const rawResult = evaluator(dctx);
				const result = (rawResult instanceof Promise ? await rawResult : rawResult) as SqlValue;
				if (constraintFailed(metadata, result)) {
					throw new ConstraintError(constraintViolationMessage(metadata, result));
				}
				return result ?? null;
			};
			rctx.db._queueDeferredConstraintRow(
				metadata.baseTable,
				metadata.constraintName,
				flatRow,
				metadata.flatRowDescriptor,
				deferredEvaluator,
				activeConnectionId,
				contextRow,
				metadata.contextDescriptor
			);
			continue;
		}

		// Resolve without a per-row microtask hop (see runtime/async-util.ts).
		const rawResult = evaluator(rctx);
		const result = (rawResult instanceof Promise ? await rawResult : rawResult) as SqlValue;

		if (constraintFailed(metadata, result)) {
			const baseMessage = constraintViolationMessage(metadata, result);

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
