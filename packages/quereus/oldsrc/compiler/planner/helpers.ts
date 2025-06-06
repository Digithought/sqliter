import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type * as AST from '../../parser/ast.js';
import type { TableSchema } from '../../schema/table.js';
import type { IndexOrderBy, IndexInfo } from '../../vtab/indexInfo.js';
import type { Compiler } from '../compiler.js';
import type { CursorPlanningResult } from '../structs.js';
import { extractConstraints } from './constraints.js';
import { calculateColumnUsage } from './columns.js';
import type { PlannedStep } from './types.js';
import { createLogger } from '../../common/logger.js';
import { QueryPlannerContext } from './context.js';
import type { ColumnSchema } from '../../schema/column.js';
import { MemoryTableModule } from '../../vtab/memory/module.js';
import { expressionToString } from '../../util/ddl-stringify.js';

// Define and export loggers at the top level
export const log = createLogger('compiler:plan');
export const warnLog = log.extend('warn');
export const errorLog = log.extend('error');

/** Helper to get the primary alias associated with a planned step */
export function getStepPrimaryAlias(step: PlannedStep): string {
	if (step.type === 'Scan') {
		return step.relation.alias;
	} else if (step.type === 'Join') {
		return step.outputRelation.alias;
	}
	return 'unknown_step';
}

export function planTableAccessHelper(
	compiler: Compiler,
	cursorIdx: number,
	tableSchema: TableSchema,
	stmt: AST.SelectStmt | AST.UpdateStmt | AST.DeleteStmt,
	activeOuterCursors: ReadonlySet<number>,
	relevantConstraints?: AST.Expression
): void {
	// Get the module associated with the table schema
	const module = tableSchema.vtabModule;

	// Check if the module provides xBestIndex
	if (typeof module.xBestIndex !== 'function') {
		compiler.cursorPlanningInfo.set(cursorIdx, {
			idxNum: 0,
			idxStr: null,
			usage: [],
			cost: 1e10,
			rows: BigInt(1000000),
			orderByConsumed: false,
			constraints: [],
			constraintExpressions: new Map(),
			handledWhereNodes: new Set(),
			nOrderBy: 0,
			aOrderBy: [],
			colUsed: BigInt(-1),
			idxFlags: 0,
			nArgs: 0,
		});
		return;
	}

	const baseWhereExpr = stmt.type === 'select' || stmt.type === 'update' || stmt.type === 'delete' ? stmt.where : undefined;
	const orderByExprs = stmt.type === 'select' ? stmt.orderBy : undefined;
	const selectColumns = stmt.type === 'select' ? stmt.columns : [];

	// --- Combine base WHERE and relevant constraints --- >
	let combinedWhereExpr: AST.Expression | undefined = baseWhereExpr;
	if (relevantConstraints) {
		if (combinedWhereExpr) {
			// AND the two sets of constraints together
			combinedWhereExpr = {
				type: 'binary',
				operator: 'AND',
				left: combinedWhereExpr,
				right: relevantConstraints,
				// loc: baseWhereExpr.loc // Optionally try to retain location info
			};
			log(`Combining stmt.where and relevantConstraints for cursor ${cursorIdx}`);
		} else {
			combinedWhereExpr = relevantConstraints;
			log(`Using relevantConstraints as effective WHERE for cursor ${cursorIdx}`);
		}
	}
	// < --- End combination ---

	// --- Use combined expression for constraint extraction --- >
	const { constraints, constraintExpressions, handledNodes } = extractConstraints(
		compiler, cursorIdx, tableSchema, combinedWhereExpr, activeOuterCursors
	);
	// < --- End constraint extraction change ---

	const orderBy: IndexOrderBy[] = [];
	if (orderByExprs) {
		orderByExprs.forEach(ob => {
			if (ob.expr.type === 'column') {
				const colExpr = ob.expr as AST.ColumnExpr;
				const colNameLower = colExpr.name.toLowerCase();
				let sourceCursor = -1;
				if (colExpr.table) {
					sourceCursor = compiler.tableAliases.get(colExpr.table.toLowerCase()) ?? -1;
				} else {
					if (tableSchema.columnIndexMap.has(colNameLower)) {
						sourceCursor = cursorIdx;
						for (const outerC of activeOuterCursors) {
							if (compiler.tableSchemas.get(outerC)?.columnIndexMap.has(colNameLower)) {
								sourceCursor = -1;
								break;
							}
						}
					} else {
						for (const outerC of activeOuterCursors) {
							if (compiler.tableSchemas.get(outerC)?.columnIndexMap.has(colNameLower)) {
								sourceCursor = outerC;
								break;
							}
						}
					}
				}

				if (sourceCursor === cursorIdx) {
					const colIdx = tableSchema.columnIndexMap.get(colNameLower);
					if (colIdx !== undefined) {
						orderBy.push({ iColumn: colIdx, desc: ob.direction === 'desc' });
					} else if (colNameLower === 'rowid') {
						orderBy.push({ iColumn: -1, desc: ob.direction === 'desc' });
					}
				}
			} else {
				warnLog("Skipping non-column ORDER BY term for xBestIndex planning");
			}
		});
	}

	// --- Use combined expression for column usage calculation --- >
	const colUsed = calculateColumnUsage(compiler, cursorIdx, selectColumns, combinedWhereExpr, orderByExprs);
	// < --- End column usage change ---

	const indexInfo: IndexInfo = {
		nConstraint: constraints.length,
		aConstraint: Object.freeze([...constraints]),
		nOrderBy: orderBy.length,
		aOrderBy: Object.freeze([...orderBy]),
		colUsed: colUsed,
		aConstraintUsage: Array.from({ length: constraints.length }, () => ({ argvIndex: 0, omit: false })),
		idxNum: 0,
		idxStr: null,
		orderByConsumed: false,
		estimatedCost: 1e10,
		estimatedRows: BigInt(1000000),
		idxFlags: 0,
	};

	let status: number;
	try {
		// Call xBestIndex on the *module*, passing db and table schema
		status = module.xBestIndex(compiler.db, tableSchema, indexInfo);
	} catch (e) {
		errorLog(`Error calling module xBestIndex for %s: %O`, tableSchema.name, e);
		status = StatusCode.ERROR;
	}

	if (status !== StatusCode.OK) {
		throw new QuereusError(`xBestIndex failed for table ${tableSchema.name} with code ${status}`, status, undefined, stmt.loc?.start.line, stmt.loc?.start.column);
	}

	// Calculate nArgs based on usage information from xBestIndex
	const nArgs = Math.max(0, ...(indexInfo.aConstraintUsage || []).map(u => u.argvIndex ?? 0));

	// Refine handledNodes based on the omit flag from xBestIndex usage
	const finalHandledNodes = new Set(handledNodes); // Start with nodes extracted
	if (indexInfo.aConstraintUsage) {
		indexInfo.aConstraintUsage.forEach((usage, i) => {
			if (usage.omit === false && usage.argvIndex > 0) { // If used but not omitted (i.e., VDBE must verify)
				const originalExpr = constraintExpressions.get(i);
				if (originalExpr) {
					log(`Constraint expression [${expressionToString(originalExpr)}] marked as NOT handled by VTab index (omit=false). Removing from handled set.`);
					finalHandledNodes.delete(originalExpr);
					// Also remove parent Collate node if this was the inner part
					// This requires traversing up, or storing parent info in extractConstraints.
					// For now, let's assume compileUnhandledWhereConditions handles Collate nodes correctly if the inner node is not marked handled.
				}
			}
		});
	}

	const planResult: CursorPlanningResult = {
		idxNum: indexInfo.idxNum,
		idxStr: indexInfo.idxStr,
		usage: indexInfo.aConstraintUsage,
		constraints: [...indexInfo.aConstraint],
		constraintExpressions: constraintExpressions,
		handledWhereNodes: finalHandledNodes,
		cost: indexInfo.estimatedCost,
		rows: indexInfo.estimatedRows,
		orderByConsumed: indexInfo.orderByConsumed,
		nOrderBy: indexInfo.nOrderBy,
		aOrderBy: indexInfo.aOrderBy,
		colUsed: indexInfo.colUsed,
		idxFlags: indexInfo.idxFlags,
		nArgs: nArgs,
	};
	compiler.cursorPlanningInfo.set(cursorIdx, planResult);

	log(`Plan: %s (cursor %d, outer: %s, relevantCons: %s) -> idxNum=%d cost=%.2f rows=%s usage=%j handled=%d colUsed=%s nArgs=%d`,
		tableSchema.name,
		cursorIdx,
		[...activeOuterCursors].join(','),
		!!relevantConstraints,
		planResult.idxNum,
		planResult.cost,
		planResult.rows.toString(),
		planResult.usage,
		planResult.handledWhereNodes.size,
		colUsed.toString(2),
		planResult.nArgs
	);
}

/**
 * Checks if an expression only references columns available from a specific set of cursors.
 * This is useful for determining if a WHERE clause predicate can be pushed down into a subquery.
 *
 * @param compiler The compiler instance.
 * @param expr The expression to check.
 * @param allowedCursors The set of cursor indices whose columns are allowed.
 * @returns True if the expression only references allowed columns, false otherwise.
 */
export function expressionReferencesOnlyAllowedCursors(
	compiler: Compiler,
	expr: AST.Expression | undefined,
	allowedCursors: ReadonlySet<number>
): boolean {
	if (!expr) return true; // An empty expression is trivially allowed

	let isAllowed = true;

	const traverse = (node: AST.Expression) => {
		if (!isAllowed) return; // Early exit if disallowed reference found

		if (node.type === 'column') {
			const colExpr = node as AST.ColumnExpr;
			let foundCursor = -1;
			if (colExpr.table) {
				// If table alias is specified, find its cursor
				foundCursor = compiler.tableAliases.get(colExpr.table.toLowerCase()) ?? -1;
			} else {
				// Unqualified column: check which allowed cursor provides it
				//let ambiguous = false;
				for (const cursorId of allowedCursors) {
					const schema = compiler.tableSchemas.get(cursorId);
					if (schema?.columnIndexMap.has(colExpr.name.toLowerCase())) {
						//if (foundCursor !== -1) ambiguous = true;
						foundCursor = cursorId;
					}
				}
				// We don't need to check outer cursors here, only allowed ones.
				// Ambiguity within allowed cursors is okay for this check.
			}

			// If the found cursor isn't one of the allowed ones, the expression is not allowed.
			if (!allowedCursors.has(foundCursor)) {
				// Also check rowid specifically
				if (colExpr.name.toLowerCase() !== 'rowid') {
					isAllowed = false;
				} else {
					// Allow rowid only if *some* allowed cursor might provide it (hard to be certain)
					// This might need refinement - does the unqualified 'rowid' refer to only one table?
					// For now, assume if only one allowed cursor, rowid refers to it.
					if (allowedCursors.size !== 1) {
						// If rowid is qualified, check that specific cursor
						if (colExpr.table) {
							if (!allowedCursors.has(foundCursor)) isAllowed = false;
						} else {
							isAllowed = false; // Ambiguous unqualified rowid with multiple allowed cursors
						}
					}
				}
			}
		} else if (node.type === 'binary') {
			// For AND, both sides must be allowed.
			// For other binary ops, if either side references a disallowed cursor,
			// the whole expression cannot be pushed down based on allowed cursors alone.
			traverse(node.left);
			traverse(node.right);
			// For OR, pushdown is more complex and not handled by this check.
			if (node.operator.toUpperCase() === 'OR') {
				warnLog("Predicate pushdown check: OR expressions are currently not pushed down.");
				isAllowed = false;
			}
		} else if (node.type === 'unary') {
			traverse(node.expr);
		} else if (node.type === 'function') {
			// Functions themselves are okay, check their arguments
			node.args.forEach(traverse);
		} else if (node.type === 'cast') {
			traverse(node.expr);
		} else if (node.type === 'subquery') {
			// Subqueries within the predicate are tricky.
			// If the subquery is correlated with cursors *outside* the allowed set,
			// then the predicate cannot be pushed down.
			// For simplicity now, disallow predicates containing subqueries.
			warnLog("Predicate pushdown check: Predicates containing subqueries are currently not pushed down.");
			isAllowed = false;
		} else if (node.type === 'collate') {
			traverse(node.expr);
		} else if (node.type === 'identifier') {
			// Treat identifier as an unqualified column for dependency checking
			traverse({ type: 'column', name: node.name, loc: node.loc });
		} else if (node.type === 'literal' || node.type === 'parameter') {
			// Literals and parameters are always allowed
		} else {
			// Any other expression type is currently disallowed for simplicity
			warnLog(`Predicate pushdown check: Unhandled expression type '${(node as any).type}' disallowed.`);
			isAllowed = false;
		}
	};

	traverse(expr);
	return isAllowed;
}

/**
 * Estimates the cost of executing a subquery SELECT statement.
 * This is a placeholder and currently uses heuristics.
 *
 * @param compiler The compiler instance.
 * @param subquerySelect The SELECT AST node of the subquery.
 * @param outerCursors Cursors available from the outer context.
 * @param predicate Optional predicate pushed down into the subquery.
 * @returns Estimated cost and rows.
 */
export function estimateSubqueryCost(
	compiler: Compiler,
	subquerySelect: AST.SelectStmt,
	outerCursors: ReadonlySet<number>,
	_predicate?: AST.Expression // The predicate already pushed into subquerySelect.where
): { cost: number, rows: bigint } {
	log(`Recursively estimating cost for subquery starting line ${subquerySelect.loc?.start.line ?? '?'}`);

	// 1. Create a new planner context for the subquery, passing outer cursors
	const subContext = new QueryPlannerContext(compiler, subquerySelect, outerCursors);

	// 2. Execute the planner for the subquery
	const plannedSteps = subContext.planExecution();

	// 3. Extract cost and rows from the final step
	let estimatedCost = 1e9; // Default high cost
	let estimatedRows = BigInt(1000000); // Default high rows

	if (plannedSteps.length > 0) {
		const finalStep = plannedSteps[plannedSteps.length - 1];
		if (finalStep.type === 'Scan') {
			estimatedCost = finalStep.plan.cost;
			estimatedRows = finalStep.plan.rows;
		} else if (finalStep.type === 'Join') {
			estimatedCost = finalStep.outputRelation.estimatedCost;
			estimatedRows = finalStep.outputRelation.estimatedRows;
		}
		log(` -> Subquery plan final step (${finalStep.type}): Cost=%.2f, Rows=%d`, estimatedCost, estimatedRows);
	} else {
		// Handle cases with no FROM clause or empty plans (e.g., SELECT 1)
		// This might need refinement based on how QueryPlannerContext handles no-FROM
		if (!subquerySelect.from || subquerySelect.from.length === 0) {
			log(` -> Subquery has no FROM clause. Estimating minimal cost.`);
			// TODO: Estimate cost of evaluating SELECT expressions if needed
			estimatedCost = 10; // Small cost for simple expressions
			estimatedRows = 1n; // Typically produces one row
		} else {
			warnLog(` -> Subquery planning yielded no steps. Using default high cost/rows.`);
		}
	}

	// --- Adjust row estimate for GROUP BY / DISTINCT --- //
	if (subquerySelect.groupBy && subquerySelect.groupBy.length > 0) {
		const reductionFactor = 0.3; // Heuristic: Grouping significantly reduces rows
		const reducedRows = BigInt(Math.max(1, Math.round(Number(estimatedRows) * reductionFactor)));
		log(` -> Applying GROUP BY, reducing estimated rows from ${estimatedRows} to ${reducedRows} (factor: ${reductionFactor})`);
		estimatedRows = reducedRows;
	} else if (subquerySelect.distinct) {
		const reductionFactor = 0.5; // Heuristic: DISTINCT reduces rows
		const reducedRows = BigInt(Math.max(1, Math.round(Number(estimatedRows) * reductionFactor)));
		log(` -> Applying DISTINCT, reducing estimated rows from ${estimatedRows} to ${reducedRows} (factor: ${reductionFactor})`);
		estimatedRows = reducedRows;
	}

	// 4. Apply LIMIT clause adjustments (after core planning)
	if (subquerySelect.limit) {
		// Limit clause drastically reduces rows (and potentially cost)
		// This is a very rough guess
		const limitExpr = subquerySelect.limit; // Access the limit expression directly

		let limitVal: bigint | undefined;
		if (limitExpr.type === 'literal') {
			if (typeof limitExpr.value === 'bigint' && limitExpr.value >= 0n) {
				limitVal = limitExpr.value;
			} else if (typeof limitExpr.value === 'number' && Number.isInteger(limitExpr.value) && limitExpr.value >= 0) {
				limitVal = BigInt(limitExpr.value); // Convert number to bigint
			}
		}

		if (limitVal !== undefined) {
			if (limitVal < estimatedRows) {
				estimatedRows = limitVal;
				// Assume cost reduction proportional to row reduction? Very rough.
				// Let's keep the planned cost but cap the rows.
				log(` -> Applying literal LIMIT ${limitVal}, capping rows.`);
			}
		} else {
			// Cannot apply optimization if limit is not a simple literal non-negative integer
			log(` -> LIMIT clause is present but not a simple literal non-negative integer. Applying generic cost reduction.`);
		}
		// Simple heuristic: LIMIT reduces cost somewhat regardless of value complexity for now.
		estimatedCost *= 0.9; // Reduce cost slightly for having a limit
	}

	// 5. Return the final estimate
	log(` -> Final estimated subquery cost: %.2f, rows: %d`, estimatedCost, estimatedRows);
	return { cost: estimatedCost, rows: estimatedRows };
}

export function combineSchemas(
	leftSchema: Readonly<TableSchema>,
	rightSchema: Readonly<TableSchema>,
	joinType: AST.JoinClause['joinType'] | 'cross',
	leftSchemaWasOriginalLeft: boolean
): TableSchema {
	const newColumns: ColumnSchema[] = [];
	const newColumnIndexMap = new Map<string, number>();
	let colIdx = 0;

	const processSchema = (schema: Readonly<TableSchema>, isPotentiallyNullable: boolean, originalAlias: string) => {
		schema.columns.forEach(col => {
			if (col.hidden) return;

			// Crude name uniquification for this example. Real system might need more robust handling (e.g. SQL rules for USING/NATURAL)
			let newColName = col.name;
			if (newColumnIndexMap.has(newColName.toLowerCase())) {
				newColName = `${originalAlias}_${col.name}`;
			}
			if (newColumnIndexMap.has(newColName.toLowerCase())) { // Still a clash after prefixing
				 newColName = `${originalAlias}_${col.name}_${colIdx}`;
			}

			newColumns.push({
				...col,
				name: newColName,
				notNull: isPotentiallyNullable ? false : col.notNull, // Key part for LEFT/RIGHT join nullability
				// PK status is not typically inherited directly across joins in this manner
				primaryKey: false,
				pkOrder: 0
			});
			newColumnIndexMap.set(newColName.toLowerCase(), colIdx++);
		});
	};

	let leftIsNullable = false;
	let rightIsNullable = false;

	if (joinType === 'left') {
		// In A LEFT JOIN B, B (the right side) is nullable.
		// If leftSchemaWasOriginalLeft is true, rightSchema is the one to mark nullable.
		// If leftSchemaWasOriginalLeft is false, leftSchema is the one to mark nullable (original was B LEFT JOIN A, planner chose A as outer).
		rightIsNullable = leftSchemaWasOriginalLeft;
		leftIsNullable = !leftSchemaWasOriginalLeft;
	} else if (joinType === 'right') {
		// In A RIGHT JOIN B, A (the left side) is nullable.
		leftIsNullable = leftSchemaWasOriginalLeft;
		rightIsNullable = !leftSchemaWasOriginalLeft;
	} else if (joinType === 'full') {
		leftIsNullable = true;
		rightIsNullable = true;
	}
	// For INNER and CROSS joins, nullability is inherited from original columns.

	processSchema(leftSchema, leftIsNullable, leftSchema.name);
	processSchema(rightSchema, rightIsNullable, rightSchema.name);

	const combinedSchemaName = `join_${leftSchema.name}_${rightSchema.name}`;

	return {
		name: combinedSchemaName,
		schemaName: leftSchema.schemaName,
		columns: newColumns,
		columnIndexMap: newColumnIndexMap,
		primaryKeyDefinition: [],
		checkConstraints: [],
		vtabModule: new MemoryTableModule(),
		vtabModuleName: 'internal_join',
		isTemporary: true,
		isView: false,
		isStrict: false,
		isWithoutRowid: true,
	};
}

