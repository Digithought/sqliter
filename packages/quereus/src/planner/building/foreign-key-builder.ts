import type { PlanningContext } from '../planning-context.js';
import type { TableSchema, ForeignKeyConstraintSchema, RowConstraintSchema } from '../../schema/table.js';
import { RowOpFlag, type RowOpMask, resolveReferencedColumns } from '../../schema/table.js';
import type { SchemaManager } from '../../schema/manager.js';
import { ConflictResolution } from '../../common/constants.js';
import type { Attribute, ScalarPlanNode } from '../nodes/plan-node.js';
import type { ConstraintCheck } from '../nodes/constraint-check-node.js';
import { RegisteredScope } from '../scopes/registered.js';
import { buildExpression } from './expression.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { columnSchemaToScalarType } from '../type-utils.js';
import { basisFksOverriddenByDivergentLensFk } from '../../schema/lens-fk-discovery.js';
import * as AST from '../../parser/ast.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('planner:fk-builder');

/**
 * Builds a SELECT 1 FROM [<schema>.]<table> WHERE <col pairs joined by AND>
 * subquery AST. Shared by both EXISTS and NOT EXISTS FK checks. `fromSchema`
 * qualifies the FROM relation so it resolves regardless of the surrounding
 * search path — the lens FK collector passes the logical schema so the parent
 * resolves to the registered logical view even though the routed constraint is
 * built under the basis schema path.
 */
function synthesizeFKSubquery(
	fromTableName: string,
	columnPairs: Array<{ leftTable: string; leftCol: string; rightTable: string; rightCol: string }>,
	fromSchema?: string,
): AST.SelectStmt {
	const conditions: AST.Expression[] = columnPairs.map(({ leftTable, leftCol, rightTable, rightCol }) => ({
		type: 'binary',
		operator: '=',
		left: { type: 'column', name: leftCol, table: leftTable } as AST.ColumnExpr,
		right: { type: 'column', name: rightCol, table: rightTable } as AST.ColumnExpr,
	} as AST.BinaryExpr));

	const whereExpr = conditions.length === 1
		? conditions[0]
		: conditions.reduce((acc, cond) => ({
			type: 'binary',
			operator: 'AND',
			left: acc,
			right: cond,
		} as AST.BinaryExpr));

	return {
		type: 'select',
		columns: [{ type: 'column', expr: { type: 'literal', value: 1 } as AST.LiteralExpr }],
		from: [{
			type: 'table',
			table: { type: 'identifier', name: fromTableName, schema: fromSchema },
		} as AST.TableSource],
		where: whereExpr,
	};
}

/**
 * Assembles the MATCH SIMPLE-guarded child-side FK existence expression:
 *
 *   ( <q>.<child1> IS NULL OR … OR
 *     EXISTS(SELECT 1 FROM [<schema>.]<parent> WHERE <parent>.<ref_i> = <q>.<child_i> …) )
 *
 * The child column names are taken verbatim — the physical builder passes the
 * child table's own column names; the lens collector passes basis-rewritten
 * names. The parent column names are the referenced-column names (logical names
 * for the lens, which resolve against the logical view named by `fromSchema`).
 * Shared by the physical child-side FK check and the lens FK collector so the
 * synthesis lives in exactly one place.
 */
export function synthesizeFKExistsExpr(
	parentTableName: string,
	parentColumns: readonly string[],
	childColumns: readonly string[],
	qualifier: 'NEW' | 'OLD',
	fromSchema?: string,
): AST.Expression {
	const pairs = childColumns.map((childCol, i) => ({
		leftTable: parentTableName,
		leftCol: parentColumns[i],
		rightTable: qualifier,
		rightCol: childCol,
	}));

	const existsExpr: AST.ExistsExpr = {
		type: 'exists',
		subquery: synthesizeFKSubquery(parentTableName, pairs, fromSchema),
	};

	// MATCH SIMPLE (SQL default): FK is satisfied when any referencing column is NULL.
	// Wrap EXISTS with OR-chained IS NULL guards to skip the subquery in that case.
	const nullGuards: AST.UnaryExpr[] = childColumns.map((childCol) => ({
		type: 'unary',
		operator: 'IS NULL',
		expr: { type: 'column', name: childCol, table: qualifier } as AST.ColumnExpr,
	}));

	return nullGuards.reduceRight<AST.Expression>(
		(acc, guard) => ({ type: 'binary', operator: 'OR', left: guard, right: acc } as AST.BinaryExpr),
		existsExpr,
	);
}

/**
 * Assembles the parent-side FK non-existence expression:
 *
 *   not exists (select 1 from [<schema>.]<child> where <child>.<childCol_i> = <q>.<parentCol_i> …)
 *
 * The dual of {@link synthesizeFKExistsExpr}: the physical parent-side RESTRICT
 * check passes the child table's own column names and the parent's referenced
 * column names off the `TableSchema`s (no `fromSchema`); the lens parent-side
 * collector passes the logical child column names, the parent's referenced
 * columns rewritten to basis terms, and the logical child schema as `fromSchema`
 * so the child relation resolves to the registered logical view regardless of the
 * basis search path the routed constraint is built under. Shared so the
 * `NOT EXISTS` synthesis lives in exactly one place.
 */
export function synthesizeFKNotExistsExpr(
	childTableName: string,
	childColumns: readonly string[],
	parentColumns: readonly string[],
	qualifier: 'NEW' | 'OLD',
	fromSchema?: string,
): AST.UnaryExpr {
	const pairs = childColumns.map((childCol, i) => ({
		leftTable: childTableName,
		leftCol: childCol,
		rightTable: qualifier,
		rightCol: parentColumns[i],
	}));

	return {
		type: 'unary',
		operator: 'NOT',
		expr: {
			type: 'exists',
			subquery: synthesizeFKSubquery(childTableName, pairs, fromSchema),
		} as AST.ExistsExpr,
	};
}

/**
 * Synthesizes an EXISTS(...) AST expression that checks whether a matching row
 * exists in the parent table for the given FK columns.
 *
 * Generates: EXISTS(SELECT 1 FROM parent WHERE parent.col1 = NEW.fk1 AND parent.col2 = NEW.fk2)
 */
function synthesizeExistsCheck(
	fk: ForeignKeyConstraintSchema,
	childTable: TableSchema,
	parentTable: TableSchema,
	parentColIndices: number[],
	qualifier: 'new' | 'old',
): AST.Expression {
	const parentColumns = parentColIndices.map(i => parentTable.columns[i].name);
	const childColumns = fk.columns.map(childColIdx => childTable.columns[childColIdx].name);
	// Thread the parent's own schema so the synthesized `from <parent>` resolves to
	// the correct table even when the parent lives in a different schema than the
	// child (a no-op for the same-schema case — the search path already resolves it).
	return synthesizeFKExistsExpr(
		parentTable.name,
		parentColumns,
		childColumns,
		qualifier.toUpperCase() as 'NEW' | 'OLD',
		parentTable.schemaName,
	);
}

/**
 * Synthesizes a NOT EXISTS(...) AST expression that checks no child rows
 * reference the old parent values.
 *
 * Generates: NOT EXISTS(SELECT 1 FROM child WHERE child.fk1 = OLD.pk1 AND ...)
 */
function synthesizeNotExistsCheck(
	fk: ForeignKeyConstraintSchema,
	childTable: TableSchema,
	parentTable: TableSchema,
	parentColIndices: number[],
): AST.UnaryExpr {
	const childColumns = fk.columns.map(childColIdx => childTable.columns[childColIdx].name);
	const parentColumns = parentColIndices.map(idx => parentTable.columns[idx].name);
	// Physical path: child/parent names off the `TableSchema`s. Thread the child's
	// own schema as `fromSchema` so the synthesized `from <child>` resolves correctly
	// when the child lives in a different schema than the parent (a no-op same-schema).
	return synthesizeFKNotExistsExpr(childTable.name, childColumns, parentColumns, 'OLD', childTable.schemaName);
}

/**
 * Builds child-side FK constraint checks (for INSERT/UPDATE on the referencing table).
 * For each FK, generates an EXISTS check ensuring the parent row exists.
 */
export function buildChildSideFKChecks(
	ctx: PlanningContext,
	tableSchema: TableSchema,
	operation: RowOpFlag,
	oldAttributes: Attribute[],
	newAttributes: Attribute[],
	contextAttributes: Attribute[] = [],
): ConstraintCheck[] {
	if (!tableSchema.foreignKeys || tableSchema.foreignKeys.length === 0) return [];
	// Child-side only applies to INSERT and UPDATE
	if (operation !== RowOpFlag.INSERT && operation !== RowOpFlag.UPDATE) return [];

	const checks: ConstraintCheck[] = [];

	for (const fk of tableSchema.foreignKeys) {
		// Resolve parent table. If absent, MATCH SIMPLE still allows the row when any
		// FK column is NULL — but otherwise no parent row can match, so the check must
		// fail. Build a null-guard chain terminated by a falsy literal in that case.
		const parentSchema = ctx.schemaManager.findTable(
			fk.referencedTable,
			fk.referencedSchema,
		);

		let existsExpr: AST.Expression;
		if (!parentSchema) {
			log(`FK '${fk.name}': parent table '${fk.referencedTable}' not found; emitting null-guards-only check`);
			const nullGuards: AST.UnaryExpr[] = fk.columns.map((childColIdx) => ({
				type: 'unary',
				operator: 'IS NULL',
				expr: { type: 'column', name: tableSchema.columns[childColIdx].name, table: 'NEW' } as AST.ColumnExpr,
			}));
			existsExpr = nullGuards.reduceRight<AST.Expression>(
				(acc, guard) => ({ type: 'binary', operator: 'OR', left: guard, right: acc } as AST.BinaryExpr),
				{ type: 'literal', value: 0 } as AST.LiteralExpr,
			);
		} else {
			const parentColIndices = resolveReferencedColumns(fk, parentSchema);
			if (parentColIndices.length !== fk.columns.length) {
				log(`FK check skipped: column count mismatch for FK '${fk.name}'`);
				continue;
			}

			// Synthesize EXISTS(SELECT 1 FROM parent WHERE parent.ref = NEW.fk)
			existsExpr = synthesizeExistsCheck(fk, tableSchema, parentSchema, parentColIndices, 'new');
		}

		// Build as a RowConstraintSchema so it integrates with existing infrastructure
		const syntheticConstraint: RowConstraintSchema = {
			name: fk.name ?? `_fk_${tableSchema.name}`,
			expr: existsExpr,
			operations: (RowOpFlag.INSERT | RowOpFlag.UPDATE) as RowOpMask,
			deferrable: true,
			initiallyDeferred: true,
		};

		// Build the expression using a scope with OLD/NEW column access
		const constraintScope = new RegisteredScope(ctx.scope);

		// Register mutation context variables
		contextAttributes.forEach((attr, contextVarIndex) => {
			if (contextVarIndex < (tableSchema.mutationContext?.length || 0)) {
				const contextVar = tableSchema.mutationContext![contextVarIndex];
				const varNameLower = contextVar.name.toLowerCase();
				constraintScope.registerSymbol(varNameLower, (exp, s) =>
					new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, contextVarIndex)
				);
			}
		});

		// Register column symbols
		tableSchema.columns.forEach((tableColumn, tableColIndex) => {
			const colNameLower = tableColumn.name.toLowerCase();

			const newAttr = newAttributes[tableColIndex];
			if (newAttr) {
				// Carry the column's declared collation so a FK comparison over a
				// collated child column resolves the same collation a read-path
				// query would (mirrors the CHECK constraint scope).
				const newColumnType = columnSchemaToScalarType(tableColumn);

				constraintScope.registerSymbol(`new.${colNameLower}`, (exp, s) =>
					new ColumnReferenceNode(s, exp as AST.ColumnExpr, newColumnType, newAttr.id, tableColIndex));

				if (operation === RowOpFlag.INSERT || operation === RowOpFlag.UPDATE) {
					constraintScope.registerSymbol(colNameLower, (exp, s) =>
						new ColumnReferenceNode(s, exp as AST.ColumnExpr, newColumnType, newAttr.id, tableColIndex));
				}
			}

			const oldAttr = oldAttributes[tableColIndex];
			if (oldAttr) {
				const oldColumnType = columnSchemaToScalarType(tableColumn, { nullable: true });

				constraintScope.registerSymbol(`old.${colNameLower}`, (exp, s) =>
					new ColumnReferenceNode(s, exp as AST.ColumnExpr, oldColumnType, oldAttr.id, tableColIndex));
			}
		});

		const originalCurrentSchema = ctx.schemaManager.getCurrentSchemaName();
		const needsSchemaSwitch = tableSchema.schemaName !== originalCurrentSchema;
		if (needsSchemaSwitch) ctx.schemaManager.setCurrentSchema(tableSchema.schemaName);

		try {
			const constraintSchemaPath = [tableSchema.schemaName];
			const constraintCtx = { ...ctx, scope: constraintScope, schemaPath: constraintSchemaPath };

			const expression = buildExpression(constraintCtx, existsExpr) as ScalarPlanNode;

			checks.push({
				constraint: syntheticConstraint,
				expression,
				deferrable: true,
				initiallyDeferred: true,
				needsDeferred: true,
				kind: 'fk-child',
			});
		} finally {
			if (needsSchemaSwitch) ctx.schemaManager.setCurrentSchema(originalCurrentSchema);
		}
	}

	return checks;
}

/**
 * Builds parent-side FK constraint checks (for DELETE/UPDATE on the referenced table).
 * For each FK that references this table, generates a NOT EXISTS check for RESTRICT/NO ACTION.
 */
export function buildParentSideFKChecks(
	ctx: PlanningContext,
	tableSchema: TableSchema,
	operation: RowOpFlag,
	oldAttributes: Attribute[],
	newAttributes: Attribute[],
	contextAttributes: Attribute[] = [],
): ConstraintCheck[] {
	// Parent-side only applies to DELETE and UPDATE
	if (operation !== RowOpFlag.DELETE && operation !== RowOpFlag.UPDATE) return [];

	const checks: ConstraintCheck[] = [];

	// Basis RESTRICT FKs a divergent non-RESTRICT logical FK overrides — their immediate
	// plan-time NOT EXISTS is suppressed so the parent write a logical cascade must
	// complete is not rejected. Cheap-empty when no lens slot is backed by `tableSchema`.
	const suppressed = basisFksOverriddenByDivergentLensFk(
		tableSchema,
		operation === RowOpFlag.DELETE ? 'delete' : 'update',
		ctx.schemaManager,
	);

	// The reverse FK index is keyed on the referenced schema.table, so the two discovery
	// filters (referencedTable / targetSchema match) are satisfied by the lookup and drop
	// out; only RESTRICT FKs generate a parent-side check (the per-FK body is unchanged).
	for (const { childTable, fk } of ctx.schemaManager.getReferencingForeignKeys(tableSchema.schemaName, tableSchema.name)) {
		const action = operation === RowOpFlag.DELETE ? fk.onDelete : fk.onUpdate;

		// Only RESTRICT generates parent-side checks. CASCADE, SET NULL,
		// and SET DEFAULT are handled by cascading actions in
		// runtime/foreign-key-actions.
		if (action !== 'restrict') continue;

		// Suppressed: a divergent non-RESTRICT logical FK over the same columns
		// replaces this basis RESTRICT (the logical cascade must complete, not be
		// rejected by the immediate plan-time NOT EXISTS).
		if (suppressed.has(fk)) continue;

		const parentColIndices = resolveReferencedColumns(fk, tableSchema);
		if (parentColIndices.length !== fk.columns.length) continue;

		// For UPDATE, the runtime skips this check when none of `parentColIndices`
		// changed (see emit/constraint-check.ts).

		// Synthesize NOT EXISTS(SELECT 1 FROM child WHERE child.fk = OLD.pk)
		const notExistsExpr = synthesizeNotExistsCheck(fk, childTable, tableSchema, parentColIndices);

		const isRestrict = action === 'restrict';
		const syntheticConstraint: RowConstraintSchema = {
			name: fk.name ?? `_fk_parent_${childTable.name}_${tableSchema.name}`,
			expr: notExistsExpr,
			operations: (RowOpFlag.DELETE | RowOpFlag.UPDATE) as RowOpMask,
			deferrable: !isRestrict, // RESTRICT is immediate
			initiallyDeferred: !isRestrict,
		};

		// Build scope with OLD/NEW column access
		const constraintScope = new RegisteredScope(ctx.scope);

		contextAttributes.forEach((attr, contextVarIndex) => {
			if (contextVarIndex < (tableSchema.mutationContext?.length || 0)) {
				const contextVar = tableSchema.mutationContext![contextVarIndex];
				constraintScope.registerSymbol(contextVar.name.toLowerCase(), (exp, s) =>
					new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, contextVarIndex)
				);
			}
		});

		tableSchema.columns.forEach((tableColumn, tableColIndex) => {
			const colNameLower = tableColumn.name.toLowerCase();

			const oldAttr = oldAttributes[tableColIndex];
			if (oldAttr) {
				const oldColumnType = columnSchemaToScalarType(tableColumn);

				constraintScope.registerSymbol(`old.${colNameLower}`, (exp, s) =>
					new ColumnReferenceNode(s, exp as AST.ColumnExpr, oldColumnType, oldAttr.id, tableColIndex));

				// For DELETE, unqualified defaults to OLD
				if (operation === RowOpFlag.DELETE) {
					constraintScope.registerSymbol(colNameLower, (exp, s) =>
						new ColumnReferenceNode(s, exp as AST.ColumnExpr, oldColumnType, oldAttr.id, tableColIndex));
				}
			}

			const newAttr = newAttributes[tableColIndex];
			if (newAttr) {
				const newColumnType = columnSchemaToScalarType(tableColumn, { nullable: true });

				constraintScope.registerSymbol(`new.${colNameLower}`, (exp, s) =>
					new ColumnReferenceNode(s, exp as AST.ColumnExpr, newColumnType, newAttr.id, tableColIndex));

				if (operation === RowOpFlag.UPDATE) {
					constraintScope.registerSymbol(colNameLower, (exp, s) =>
						new ColumnReferenceNode(s, exp as AST.ColumnExpr, newColumnType, newAttr.id, tableColIndex));
				}
			}
		});

		const originalCurrentSchema = ctx.schemaManager.getCurrentSchemaName();
		const needsSchemaSwitch = tableSchema.schemaName !== originalCurrentSchema;
		if (needsSchemaSwitch) ctx.schemaManager.setCurrentSchema(tableSchema.schemaName);

		try {
			const constraintSchemaPath = [tableSchema.schemaName];
			const constraintCtx = { ...ctx, scope: constraintScope, schemaPath: constraintSchemaPath };

			const expression = buildExpression(constraintCtx, notExistsExpr) as ScalarPlanNode;

			checks.push({
				constraint: syntheticConstraint,
				expression,
				deferrable: !isRestrict,
				initiallyDeferred: !isRestrict,
				needsDeferred: !isRestrict, // RESTRICT must be immediate, not deferred
				kind: 'fk-parent',
				referencedColumnIndices: parentColIndices,
			});
		} finally {
			if (needsSchemaSwitch) ctx.schemaManager.setCurrentSchema(originalCurrentSchema);
		}
	}

	return checks;
}

/**
 * One inbound RESTRICT FK eligible for statement-end batched enforcement —
 * discovery output of {@link getBatchableRestrictFks}, consumed by the runtime
 * batch machinery (`runtime/foreign-key-actions.ts`).
 */
export interface BatchableRestrictFk {
	readonly childTable: TableSchema;
	readonly fk: ForeignKeyConstraintSchema;
	/** Referenced-column indices into the PARENT table's row, aligned with `fk.columns`. */
	readonly parentColIndices: number[];
}

/**
 * Batchability gate for parent-side RESTRICT enforcement on a DELETE/UPDATE
 * against `tableSchema`. When the statement shape is provably equivalent under
 * statement-end checking, the per-row parent-side `NOT EXISTS` plan checks AND
 * the per-row runtime RESTRICT pre-walk are both replaced by ONE batched probe
 * per inbound FK at end of statement (see `flushParentRestrictBatch`). Shared
 * by the plan builders (delete.ts / update.ts) and the runtime DML executor so
 * the two sides cannot disagree on the route.
 *
 * Returns the inbound RESTRICT FKs to batch (possibly empty — nothing
 * references this table), or `undefined` when the statement must keep the
 * existing per-row machinery:
 *
 * - lens-routed write: logical FK duals / divergent-FK suppression are per-row;
 * - statement conflict resolution other than default/ABORT/ROLLBACK: FAIL and
 *   IGNORE have per-row keep/skip semantics a statement-end check cannot honor,
 *   REPLACE resolves per row;
 * - any inbound FK whose op-appropriate action is not `'restrict'`: the per-row
 *   transitive pre-walk must interleave with cascade execution, and a cascade
 *   could delete a RESTRICT child's rows mid-statement;
 * - any self-referential inbound FK (child table === parent table): its check
 *   outcome depends on which rows the same statement has already deleted.
 *
 * An inbound FK whose referenced-column resolution is malformed (column-count
 * mismatch) is skipped from the batch — the per-row paths skip it identically,
 * so it never disqualifies. The `foreign_keys` pragma is NOT part of the gate;
 * callers check it (the plan side already gates the build, the runtime flush
 * re-checks at execution).
 */
export function getBatchableRestrictFks(
	schemaManager: SchemaManager,
	tableSchema: TableSchema,
	operation: 'delete' | 'update',
	onConflict: ConflictResolution | undefined,
	lensRouted: boolean,
): BatchableRestrictFk[] | undefined {
	if (lensRouted) return undefined;
	if (onConflict !== undefined
		&& onConflict !== ConflictResolution.ABORT
		&& onConflict !== ConflictResolution.ROLLBACK) {
		return undefined;
	}

	const batchable: BatchableRestrictFk[] = [];
	for (const { childTable, fk } of schemaManager.getReferencingForeignKeys(tableSchema.schemaName, tableSchema.name)) {
		const action = operation === 'delete' ? fk.onDelete : fk.onUpdate;
		if (action !== 'restrict') return undefined;
		if (childTable.schemaName.toLowerCase() === tableSchema.schemaName.toLowerCase()
			&& childTable.name.toLowerCase() === tableSchema.name.toLowerCase()) {
			return undefined;
		}
		const parentColIndices = resolveReferencedColumns(fk, tableSchema);
		if (parentColIndices.length !== fk.columns.length) continue; // malformed — per-row skips it too
		batchable.push({ childTable, fk, parentColIndices });
	}
	return batchable;
}
