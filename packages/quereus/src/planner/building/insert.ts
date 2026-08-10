import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { InsertNode } from '../nodes/insert-node.js';
import { buildTableReference } from './table.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { buildSelectStmt, buildValuesStmt } from './select.js';
import { buildUpdateStmt } from './update.js';
import { buildDeleteStmt } from './delete.js';
import { buildWithContext } from './select-context.js';
import { resolveCteTarget, contextForCteTarget } from './dml-target.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type Attribute, type RowDescriptor } from '../nodes/plan-node.js';
import { buildExpression } from './expression.js';
import { checkColumnsAssignable, columnSchemaToDef, columnSchemaToScalarType } from '../type-utils.js';
import type { ColumnDef } from '../../common/datatype.js';
import { RegisteredScope } from '../scopes/registered.js';
import type { Scope } from '../scopes/scope.js';
import { buildRowDefaultScope } from './default-scope.js';
import { ColumnReferenceNode, TableReferenceNode } from '../nodes/reference.js';
import { SinkNode } from '../nodes/sink-node.js';
import { ConstraintCheckNode } from '../nodes/constraint-check-node.js';
import { RowOpFlag, type TableSchema, type RowConstraintSchema } from '../../schema/table.js';
import { uniqueEnforcementCollations } from '../../schema/unique-enforcement.js';
import { ReturningNode, type ReturningProjection } from '../nodes/returning-node.js';
import { expandReturningStar } from './returning-star.js';
import { ProjectNode, type Projection } from '../nodes/project-node.js';
import { buildOldNewRowDescriptors } from '../../util/row-descriptor.js';
import { DmlExecutorNode, type UpsertClausePlan, type UpsertUpdateValidation } from '../nodes/dml-executor-node.js';
import { buildConstraintChecks, buildNotNullDefaults } from './constraint-builder.js';
import { buildChildSideFKChecks, buildParentSideFKChecks, getBatchableRestrictFks } from './foreign-key-builder.js';
import { schemaAuthoredContext } from './schema-authored-context.js';
import { validateDeterministicDefault, validateDeterministicGenerated } from '../validation/determinism-validator.js';
import { validateReturningQualifiers } from '../validation/returning-qualifier-validator.js';
import { isCommittedSchemaRef } from './schema-resolution.js';
import { buildViewMutation } from './view-mutation-builder.js';
import { isMaintainedTable, maintainedTableViewLike } from '../../schema/derivation.js';
import { isViewSchema } from '../../schema/view.js';
import { validateReservedTags } from '../../schema/reserved-tags.js';
import { raiseStmtTagDiagnostics } from './tag-diagnostics.js';
import { buildMutationContextAttributes, buildMutationContextValues, registerMutationContextSymbols, type MutationContextAttribute } from './mutation-context.js';

/**
 * Creates a uniform row expansion projection that maps any relational source
 * to the target table's column structure, filling in defaults for omitted columns.
 * This ensures INSERT works orthogonally with any relational source.
 *
 * Generated columns are handled in two stages:
 * 1. First projection expands source to table structure with NULLs for generated columns
 * 2. Second projection computes generated column values using the expanded row
 */
function createRowExpansionProjection(
	ctx: PlanningContext,
	sourceNode: RelationalPlanNode,
	targetColumns: ColumnDef[],
	tableReference: TableReferenceNode,
	contextScope?: RegisteredScope,
	/**
	 * The produced-row NEW context a synthetic decomposition / multi-source member
	 * insert threads (see {@link buildInsertStmt}'s param). When set, an omitted
	 * column's expression default resolves `new.<col>` against the **produced logical
	 * row's** supplied columns (the envelope), not only this member's own supplied
	 * columns — so a member default correlating on a sibling logical column the
	 * member's base table does not carry still resolves. `undefined` for an ordinary
	 * insert (single-source `new.<col>` is unchanged).
	 */
	defaultRowContextScope?: Scope,
): RelationalPlanNode {
	const tableSchema = tableReference.tableSchema;
	const hasGeneratedColumns = tableSchema.columns.some(col => col.generated);

	// If we're inserting into all columns in table order with no generated columns, no expansion needed
	if (!hasGeneratedColumns && targetColumns.length === tableSchema.columns.length) {
		const allColumnsMatch = targetColumns.every((tc, i) =>
			tc.name.toLowerCase() === tableSchema.columns[i].name.toLowerCase()
		);
		if (allColumnsMatch) {
			return sourceNode; // Source already matches table structure
		}
	}

	// Create projection expressions for each table column
	const projections: Projection[] = [];
	const sourceAttributes = sourceNode.getAttributes();

	// Expose the source-provided ("populated") columns to default expressions, built
	// lazily. A default can derive from a sibling the INSERT actually supplied, e.g.
	// `slug text default (lower(new.title))`; the `new.`-qualified form is always
	// available, and the bare form resolves too unless a same-named mutation-context
	// variable shadows it (preserving the WITH CONTEXT precedence). Columns the INSERT
	// omitted are intentionally NOT registered: they have no value yet in this same
	// projection, so a default cannot depend on another column's default (which would
	// impose an evaluation-order race). The scope is parented on contextScope so
	// mutation-context variables stay resolvable.
	//
	// INSERT is a hot path, so this is constructed only on demand — the first time an
	// omitted column carries an *expression* default. The common insert (every column
	// supplied, or only literal/NULL defaults) allocates nothing here.
	let rowScopedDefaultCtx: PlanningContext | undefined;
	const defaultCtxFor = (): PlanningContext => {
		if (rowScopedDefaultCtx) return rowScopedDefaultCtx;
		const contextVarNames = new Set(
			(tableReference.tableSchema.mutationContext ?? []).map(v => v.name.toLowerCase())
		);
		const defaultScope = buildRowDefaultScope(
			contextScope ?? defaultRowContextScope ?? ctx.scope,
			targetColumns,
			sourceAttributes,
			contextVarNames,
		);
		rowScopedDefaultCtx = { ...ctx, scope: defaultScope };
		return rowScopedDefaultCtx;
	};

	tableSchema.columns.forEach((tableColumn) => {
		// Find if this table column is in the target columns
		const targetColIndex = targetColumns.findIndex(tc =>
			tc.name.toLowerCase() === tableColumn.name.toLowerCase()
		);

		if (tableColumn.generated) {
			// Generated columns cannot be explicitly provided in INSERT
			if (targetColIndex >= 0) {
				throw new QuereusError(
					`Cannot INSERT into generated column '${tableColumn.name}'`,
					StatusCode.ERROR
				);
			}
			// Placeholder NULL — will be replaced in the second projection pass
			projections.push({
				node: buildExpression(ctx, { type: 'literal', value: null }) as ScalarPlanNode,
				alias: tableColumn.name
			});
		} else if (targetColIndex >= 0) {
			// This column is provided by the source - reference the source column
			if (targetColIndex < sourceAttributes.length) {
				const sourceAttr = sourceAttributes[targetColIndex];
				// Create a column reference to the source attribute
				const columnRef = new ColumnReferenceNode(
					ctx.scope,
					{ type: 'column', name: sourceAttr.name } satisfies AST.ColumnExpr,
					sourceAttr.type,
					sourceAttr.id,
					targetColIndex
				);
				projections.push({
					node: columnRef,
					alias: tableColumn.name
				});
			} else {
				throw new QuereusError(
					`Source has fewer columns than expected for INSERT target columns`,
					StatusCode.ERROR
				);
			}
		} else {
			// This column is omitted - use its default expression (which may read a
			// populated sibling via `new.`) or NULL.
			let defaultNode: ScalarPlanNode;
			if (tableColumn.defaultValue !== undefined) {
				// Use default value
				if (typeof tableColumn.defaultValue === 'object' && tableColumn.defaultValue !== null && 'type' in tableColumn.defaultValue) {
					// AST expression default — resolve against the row-scoped context that
					// exposes populated siblings as `new.<column>` (built lazily, on first use).
					defaultNode = buildExpression(defaultCtxFor(), tableColumn.defaultValue as AST.Expression) as ScalarPlanNode;

					// Validate that the default expression is deterministic — skip when the
					// `nondeterministic_schema` option permits non-deterministic defaults.
					if (!ctx.db.options.getBooleanOption('nondeterministic_schema')) {
						validateDeterministicDefault(defaultNode, tableColumn.name, tableSchema.name);
					}
				} else {
					// Literal default value — no row scope needed.
					defaultNode = buildExpression(ctx, { type: 'literal', value: tableColumn.defaultValue }) as ScalarPlanNode;
				}
			} else {
				// No default value - use NULL (no row scope needed).
				defaultNode = buildExpression(ctx, { type: 'literal', value: null }) as ScalarPlanNode;
			}
			projections.push({
				node: defaultNode,
				alias: tableColumn.name
			});
		}
	});

	// Create first projection node that expands source to table structure
	let resultNode: RelationalPlanNode = new ProjectNode(ctx.scope, sourceNode, projections);

	// Second pass: compute generated column values using the expanded row
	if (hasGeneratedColumns) {
		resultNode = createGeneratedColumnProjection(ctx, resultNode, tableSchema);
	}

	return resultNode;
}

/**
 * Creates a chain of projections that compute generated column values in
 * dependency order. One projection per generated column: it passes every
 * column through and recomputes exactly one generated column whose expression
 * resolves names against the prior projection's attributes (so a generated
 * column referencing another generated column sees the freshly-computed value
 * rather than the NULL placeholder from the initial expansion).
 *
 * Topological order is taken from `tableSchema.generatedColumnTopoOrder`,
 * which the schema manager validates for cycles at CREATE/ALTER time.
 */
function createGeneratedColumnProjection(
	ctx: PlanningContext,
	sourceNode: RelationalPlanNode,
	tableSchema: TableSchema
): RelationalPlanNode {
	const topoOrder = tableSchema.generatedColumnTopoOrder ?? [];
	let currentNode: RelationalPlanNode = sourceNode;

	for (const genColIdx of topoOrder) {
		const genColumn = tableSchema.columns[genColIdx];
		if (!genColumn.generated || !genColumn.generatedExpr) continue;

		const inputAttributes = currentNode.getAttributes();

		// Scope: every column resolves to the corresponding attribute in the
		// current source. This includes generated columns processed in earlier
		// iterations — their attribute carries the freshly-computed value.
		const genScope = new RegisteredScope(ctx.scope);
		tableSchema.columns.forEach((col, colIndex) => {
			const attr = inputAttributes[colIndex];
			genScope.registerSymbol(col.name.toLowerCase(), (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, colIndex)
			);
		});

		const genCtx = { ...ctx, scope: genScope };

		const genProjections: Projection[] = tableSchema.columns.map((col, colIdx) => {
			if (colIdx === genColIdx) {
				const genNode = buildExpression(genCtx, genColumn.generatedExpr!) as ScalarPlanNode;
				if (!ctx.db.options.getBooleanOption('nondeterministic_schema')) {
					validateDeterministicGenerated(genNode, genColumn.name, tableSchema.name);
				}
				return { node: genNode, alias: col.name };
			}
			const attr = inputAttributes[colIdx];
			return {
				node: new ColumnReferenceNode(
					ctx.scope,
					{ type: 'column', name: attr.name } satisfies AST.ColumnExpr,
					attr.type,
					attr.id,
					colIdx,
				),
				alias: col.name,
			};
		});

		currentNode = new ProjectNode(ctx.scope, currentNode, genProjections);
	}

	return currentNode;
}

/**
 * Resolve the enforcement collation NAME of the constraint an `ON CONFLICT (cols)`
 * target names, per target column — index-aligned with `conflictTargetIndices`
 * (the single source of column order) — so the runtime match can compare the way
 * the constraint *enforces* rather than by byte identity. (Affinity needs no
 * per-row handling here: the proposed row is converted to declared column types
 * by the INSERT emitter before it reaches the executor.)
 *
 * The enforcement collation is the *constraint's*, not merely the column's declared
 * collation:
 *  - a PK target uses the PK column definition's collation (already column-collation
 *    or BINARY — see `createPrimaryKeyFunctions`);
 *  - a UNIQUE target uses {@link uniqueEnforcementCollations}, which prefers an
 *    index-derived per-column COLLATE.
 * Falls back to each column's declared collation when the target matches no declared
 * constraint (defensive — a valid `ON CONFLICT` names exactly one). Column order in
 * the target may differ from the constraint's, so each target index is mapped back to
 * its own column's enforcement collation, never positionally.
 */
function resolveConflictTargetEnforcement(
	tableSchema: TableSchema,
	conflictTargetIndices: number[],
): { collations: (string | undefined)[] } {
	const targetSet = new Set(conflictTargetIndices);
	const sameColumnSet = (cols: ReadonlyArray<number>): boolean =>
		cols.length === conflictTargetIndices.length && cols.every(c => targetSet.has(c));

	// PK target: the PK column definition carries the enforcement collation.
	const pkDef = tableSchema.primaryKeyDefinition;
	if (pkDef.length > 0 && sameColumnSet(pkDef.map(d => d.index))) {
		const byIndex = new Map(pkDef.map(d => [d.index, d.collation]));
		return { collations: conflictTargetIndices.map(idx => byIndex.get(idx)) };
	}

	// UNIQUE target: the matching constraint's per-column enforcement collation.
	const uc = tableSchema.uniqueConstraints?.find(u => sameColumnSet(u.columns));
	if (uc) {
		const ucCollations = uniqueEnforcementCollations(tableSchema, uc);
		const byIndex = new Map(uc.columns.map((c, i) => [c, ucCollations[i]]));
		return { collations: conflictTargetIndices.map(idx => byIndex.get(idx)) };
	}

	// Defensive fallback: the columns' declared collations.
	return { collations: conflictTargetIndices.map(idx => tableSchema.columns[idx].collation) };
}

/**
 * Register the conflicting row's columns on `scope`, under both the bare name and
 * the `<table>.<name>` qualified form. Shared by the DO UPDATE SET scope (where
 * unqualified names mean the existing row) and the generated-column recompute
 * scope, which sees the same attributes but none of the `new.` / `excluded.` ones.
 */
function registerExistingRowColumns(
	scope: RegisteredScope,
	tableSchema: TableSchema,
	existingAttributes: readonly Attribute[],
): RegisteredScope {
	existingAttributes.forEach((attr, columnIndex) => {
		const col = tableSchema.columns[columnIndex];
		const register = (symbol: string) => scope.registerSymbol(symbol, (exp, s) =>
			new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, columnIndex)
		);
		register(col.name.toLowerCase());
		register(`${tableSchema.name.toLowerCase()}.${col.name.toLowerCase()}`);
	});
	return scope;
}

/**
 * Append one implicit assignment per generated column to a DO UPDATE clause's
 * assignment map, in topological order so a generated column referencing another
 * sees the freshly-computed value when the runtime evaluates them in turn against
 * the composed row. Returns the appended column indices, in that same order.
 *
 * A generated column can never collide with a user target (the SET loop rejects
 * those), so appending into the same map is safe and keeps the node's child walk
 * order-preserving.
 *
 * The expressions get their OWN scope over the existing-row attributes rather than
 * reusing the SET scope: schema-authored SQL must not be able to bind the
 * statement's `new.` / `excluded.` symbols. Wrapped in `schemaAuthoredContext` for
 * the same reason `building/update.ts` wraps its recompute — the table's own DDL
 * resolves bare relation names in its own schema and cannot see the writing
 * statement's CTEs.
 */
function appendGeneratedRecomputes(
	ctx: PlanningContext,
	tableSchema: TableSchema,
	existingAttributes: readonly Attribute[],
	assignments: Map<number, ScalarPlanNode>,
): number[] {
	const generatedCtx = schemaAuthoredContext(
		{ ...ctx, scope: registerExistingRowColumns(new RegisteredScope(ctx.scope), tableSchema, existingAttributes) },
		tableSchema.schemaName,
	);

	const generatedAssignmentColumns: number[] = [];
	for (const colIndex of tableSchema.generatedColumnTopoOrder ?? []) {
		const col = tableSchema.columns[colIndex];
		if (!col.generated || !col.generatedExpr) continue;
		const genNode = buildExpression(generatedCtx, col.generatedExpr) as ScalarPlanNode;
		if (!ctx.db.options.getBooleanOption('nondeterministic_schema')) {
			validateDeterministicGenerated(genNode, col.name, tableSchema.name);
		}
		assignments.set(colIndex, genNode);
		generatedAssignmentColumns.push(colIndex);
	}
	return generatedAssignmentColumns;
}

/**
 * Build the UPDATE-shaped row validation an INSERT's `on conflict … do update` arm
 * runs against the row it composes — see {@link UpsertUpdateValidation}.
 *
 * This is deliberately the same construction `buildUpdateStmt` performs for a plain
 * `UPDATE` of the same table: fresh OLD/NEW attributes (OLD is a real stored row here,
 * unlike the INSERT path where OLD is all NULL), UPDATE-scoped CHECKs, both FK sides,
 * and the NOT NULL DEFAULT evaluators. The statement's own `contextAttributes` are
 * reused so a CHECK referencing a mutation-context variable binds the attribute ids
 * the executor already evaluates.
 */
function buildUpsertUpdateValidation(
	ctx: PlanningContext,
	schemaAuthoredCtx: PlanningContext,
	tableReference: TableReferenceNode,
	contextAttributes: ReadonlyArray<MutationContextAttribute>,
	lensRouted: boolean,
): UpsertUpdateValidation {
	const tableSchema = tableReference.tableSchema;

	const oldAttributes = tableSchema.columns.map((col) => ({
		id: PlanNode.nextAttrId(),
		name: col.name,
		type: columnSchemaToScalarType(col),
		sourceRelation: `OLD.${tableSchema.name}`
	}));

	const newAttributes = tableSchema.columns.map((col) => ({
		id: PlanNode.nextAttrId(),
		name: col.name,
		type: columnSchemaToScalarType(col),
		sourceRelation: `NEW.${tableSchema.name}`
	}));

	const { flatRowDescriptor } = buildOldNewRowDescriptors(oldAttributes, newAttributes);

	const checks = buildConstraintChecks(
		schemaAuthoredCtx,
		tableSchema,
		RowOpFlag.UPDATE,
		oldAttributes,
		newAttributes,
		flatRowDescriptor,
		contextAttributes
	);

	if (ctx.db.options.getBooleanOption('foreign_keys')) {
		checks.push(...buildChildSideFKChecks(
			schemaAuthoredCtx, tableSchema, RowOpFlag.UPDATE,
			oldAttributes, newAttributes, contextAttributes
		));
		// Parent-side: gated exactly as buildUpdateStmt gates it, so the two spellings
		// of the same write report a RESTRICT breach with the SAME message. Dropping the
		// plan-time `not exists` probe here loses no enforcement: `executeUpsertUpdate`
		// always runs `assertTransitiveRestrictsForParentMutation` before `vtab.update`,
		// which covers every inbound RESTRICT FK this would have (plus transitively
		// cascaded ones). `runInsert` owns no ParentRestrictBatch, so unlike `runUpdate`
		// the admitted case is enforced by that per-row pre-walk rather than one
		// end-of-statement probe — same verdict, same message, no batching.
		if (getBatchableRestrictFks(ctx.db, tableSchema, 'update', undefined, lensRouted) === undefined) {
			checks.push(...buildParentSideFKChecks(
				schemaAuthoredCtx, tableSchema, RowOpFlag.UPDATE,
				oldAttributes, newAttributes, contextAttributes
			));
		}
	}

	const notNullDefaults = buildNotNullDefaults(
		schemaAuthoredCtx, tableSchema, newAttributes, contextAttributes
	);

	return { checks, flatRowDescriptor, notNullDefaults };
}

/**
 * Builds UPSERT clause plans from AST UPSERT clauses.
 *
 * In UPSERT expressions:
 * - NEW.* refers to the proposed INSERT values
 * - Unqualified column names refer to the existing (conflicting) row values
 * - excluded.* is an alias for NEW.* (PostgreSQL compatibility)
 */
function buildUpsertClausePlans(
	ctx: PlanningContext,
	upsertClauses: AST.UpsertClause[],
	tableSchema: TableSchema,
	newAttributes: Attribute[],
): UpsertClausePlan[] {
	return upsertClauses.map(clause => {
		// Resolve conflict target columns to indices
		let conflictTargetIndices: number[] | undefined;
		if (clause.conflictTarget) {
			conflictTargetIndices = clause.conflictTarget.map(colName => {
				const colIndex = tableSchema.columns.findIndex(
					c => c.name.toLowerCase() === colName.toLowerCase()
				);
				if (colIndex === -1) {
					throw new QuereusError(
						`Column '${colName}' not found in table '${tableSchema.name}' for ON CONFLICT target`,
						StatusCode.ERROR
					);
				}
				return colIndex;
			});
		}

		// Resolve the per-target-column affinity + enforcement collation once here, so
		// the runtime conflict-target match compares the way the constraint enforces
		// (collation-equal / affinity-coerced conflicts route to the DO UPDATE / DO
		// NOTHING arm) without reaching back into the schema per row.
		const enforcement = conflictTargetIndices
			? resolveConflictTargetEnforcement(tableSchema, conflictTargetIndices)
			: undefined;

		if (clause.action === 'nothing') {
			return {
				conflictTargetIndices,
				conflictTargetCollations: enforcement?.collations,
				action: 'nothing' as const,
			};
		}

		// Build UPDATE action
		// Create attributes for the existing row (conflict row)
		const existingAttributes = tableSchema.columns.map((col) => ({
			id: PlanNode.nextAttrId(),
			name: col.name,
			type: columnSchemaToScalarType(col, { isReadOnly: true }),
			sourceRelation: `existing.${tableSchema.name}`
		}));

		// Build row descriptors for NEW (proposed) and existing (conflict) rows
		const newRowDescriptor: RowDescriptor = [];
		newAttributes.forEach((attr, index) => {
			newRowDescriptor[attr.id] = index;
		});

		const existingRowDescriptor: RowDescriptor = [];
		existingAttributes.forEach((attr, index) => {
			existingRowDescriptor[attr.id] = index;
		});

		// Create scope for UPSERT SET expressions:
		// - NEW.* and excluded.* reference proposed insert values
		// - Unqualified names reference existing row values
		const upsertScope = registerExistingRowColumns(new RegisteredScope(ctx.scope), tableSchema, existingAttributes);

		// Register NEW.* references (proposed insert values)
		newAttributes.forEach((attr, columnIndex) => {
			const col = tableSchema.columns[columnIndex];

			// NEW.column -> proposed insert value
			upsertScope.registerSymbol(`new.${col.name.toLowerCase()}`, (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, columnIndex)
			);

			// excluded.column -> proposed insert value (PostgreSQL compatibility)
			upsertScope.registerSymbol(`excluded.${col.name.toLowerCase()}`, (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, columnIndex)
			);
		});

		const upsertCtx = { ...ctx, scope: upsertScope };

		// Build assignment expressions. Authoritative backstop against assigning the
		// same base column twice in one DO UPDATE SET — keyed on the user SET target
		// name, mirroring the `building/update.ts` backstop. This path never routes
		// through `buildUpdateStmt`, so without it `set b = 1, b = 2` would silently
		// last-wins on the index-keyed map below. Reject unconditionally (no
		// value-agreement softening), matching the UPDATE-side decision.
		const assignments = new Map<number, ScalarPlanNode>();
		const seenTargets = new Set<string>();
		if (clause.assignments) {
			for (const assign of clause.assignments) {
				const targetKey = assign.column.toLowerCase();
				if (seenTargets.has(targetKey)) {
					throw new QuereusError(
						`duplicate assignment to column '${assign.column}' in ON CONFLICT DO UPDATE on '${tableSchema.name}'`,
						StatusCode.ERROR
					);
				}
				seenTargets.add(targetKey);
				const colIndex = tableSchema.columns.findIndex(
					c => c.name.toLowerCase() === assign.column.toLowerCase()
				);
				if (colIndex === -1) {
					throw new QuereusError(
						`Column '${assign.column}' not found in table '${tableSchema.name}' for DO UPDATE SET`,
						StatusCode.ERROR
					);
				}
				// Reject SET on generated columns, exactly as `building/update.ts` does —
				// this path never routes through `buildUpdateStmt`, so it needs its own
				// copy of the rule. Raised BEFORE the value expression is built so the
				// diagnostic does not depend on that expression resolving.
				if (tableSchema.columns[colIndex].generated) {
					throw new QuereusError(
						`Cannot UPDATE generated column '${assign.column}'`,
						StatusCode.ERROR
					);
				}
				const valueNode = buildExpression(upsertCtx, assign.value) as ScalarPlanNode;
				assignments.set(colIndex, valueNode);
			}
		}

		const generatedAssignmentColumns = appendGeneratedRecomputes(ctx, tableSchema, existingAttributes, assignments);

		// Build WHERE condition if present
		let whereCondition: ScalarPlanNode | undefined;
		if (clause.where) {
			whereCondition = buildExpression(upsertCtx, clause.where) as ScalarPlanNode;
		}

		return {
			conflictTargetIndices,
			conflictTargetCollations: enforcement?.collations,
			action: 'update' as const,
			assignments,
			generatedAssignmentColumns: generatedAssignmentColumns.length > 0 ? generatedAssignmentColumns : undefined,
			whereCondition,
			newRowDescriptor,
			existingRowDescriptor,
		};
	});
}

export function buildInsertStmt(
	ctx: PlanningContext,
	stmt: AST.InsertStmt,
	/**
	 * Extra row-local CHECK constraints to enforce, already resolved in the target
	 * table's column space. Set only when the view-mutation substrate re-plans a
	 * lens write onto its basis table — it threads the logical `enforced-row-local`
	 * obligations (rewritten to basis terms) here so they fire on the basis write
	 * (see `planner/mutation/lens-enforcement.ts`). Empty for ordinary inserts.
	 */
	extraConstraints: ReadonlyArray<RowConstraintSchema> = [],
	/**
	 * A pre-built relational source to use instead of building one from
	 * `stmt.source`. Set only by the multi-source view-insert decomposition, which
	 * feeds each base insert a projection over the shared-surrogate envelope
	 * (`EnvelopeScanNode`) rather than the user's VALUES/SELECT. Its output
	 * attributes are positional with `stmt.columns`. When set, `stmt.source` is
	 * ignored (a placeholder), but every other facet of the statement (target
	 * columns, ON CONFLICT, mutation context, constraint/FK/default machinery) is
	 * built exactly as for an ordinary insert.
	 */
	preBuiltSource?: RelationalPlanNode,
	/**
	 * Whether this insert is the basis-table spine of a write routed through a lens
	 * view (the view-mutation builder sets it when the target view resolves to a lens
	 * slot). Threaded onto the {@link DmlExecutorNode} so the runtime parent-side
	 * **logical** FK machinery fires only for lens-routed writes — see that node's
	 * `lensRouted` field. Default `false` for ordinary base-table inserts.
	 */
	lensRouted = false,
	/**
	 * The produced-row NEW context a synthetic decomposition / multi-source member
	 * insert threads so this member's column defaults can correlate on the **produced
	 * logical row's** other supplied columns via `new.<col>` — even ones this member's
	 * base table does not carry (e.g. an anchor key-column default
	 * `default (select … where parent.key = new.<fk>)`, where `<fk>` lives on a
	 * sibling member). It registers each supplied logical column as `new.<col>` over
	 * the shared envelope attributes, which stay resolvable through the member insert's
	 * pipeline (the narrowing envelope projection keeps them bound). Parented beneath
	 * the member's own supplied columns + mutation context, so a name a member carries
	 * itself still wins. `undefined` for an ordinary insert — single-source `new.<col>`
	 * resolution (table columns only) is unchanged.
	 */
	defaultRowContextScope?: Scope,
): PlanNode {
	// Statement-level WITH TAGS validates at the dml-stmt site on EVERY authoring
	// path — base table, view/MV-mediated (before the view dispatch below), and
	// nested DML (CTE / FROM / expression position), since they all re-enter this
	// builder. A typo'd or mis-sited `quereus.*` key fails here before any plan is
	// built, mirroring the DDL surfaces; free-form keys pass untouched.
	raiseStmtTagDiagnostics(validateReservedTags(stmt.tags, 'dml-stmt'), stmt);

	// Apply schema path from statement if present
	const contextWithSchemaPath = stmt.schemaPath
		? { ...ctx, schemaPath: stmt.schemaPath }
		: ctx;

	// Block DML on committed pseudo-schema
	if (isCommittedSchemaRef(stmt.table.schema)) {
		throw new QuereusError(`Cannot modify committed-state table 'committed.${stmt.table.name}'`, StatusCode.ERROR);
	}

	// Thread the statement's own leading WITH clause into the planning context ONCE, here,
	// and build every user-authored clause below against it — matching buildUpdateStmt /
	// buildDeleteStmt. `buildWithContext` seeds its map from `ctx.cteNodes` and merges
	// `stmt.withClause` on top, so an own-clause name shadows an inherited one while the
	// definitions this INSERT inherited from an enclosing statement stay visible. Routing
	// the definitions through the CONTEXT rather than `buildSelectStmt`'s explicit
	// `parentCTEs` argument is deliberate: that argument is precisely what leaks a
	// caller's namespace past `storedBodyContext`'s clearing on the stored-body
	// write-through path (see select-context.ts). A WITH-less insert with no parent CTEs
	// gets the context back unchanged (no overhead).
	//
	// SCHEMA-authored expressions are deliberately NOT built on this context — column
	// defaults, generated columns, CHECK constraints and FK checks are built on the
	// `schemaAuthoredContext`-derived contexts below, which clear the CTE namespace
	// outright (this statement's own definitions AND the ones it inherited), so a
	// `default (select … from c)` written in the table's DDL cannot bind a caller's
	// statement-level `c`.
	//
	// NOTE: this sits ABOVE the view / MV dispatch, so on a view target the clause is built
	// here and then AGAIN when `buildViewMutation` re-plans the statement through this same
	// builder (`buildWithClause` does not memoize). One node set ends up unreferenced —
	// wasted planning work, not a behavior change, and a DML-bodied definition still
	// executes exactly once (pinned in test/logic/13.6-cte-dml-runs-once.sqllogic).
	// `buildUpdateStmt` has the same ordering. If view write-through planning cost ever
	// shows up, memoize the clause per (context, withClause) rather than re-ordering.
	const { contextWithCTEs } = buildWithContext(contextWithSchemaPath, stmt);

	// CTE-name target: a leading `with t as (…) insert into t …` writes through the
	// CTE body via the ephemeral view-like substrate — the same predicate-driven
	// updateability framework a named view uses — and SHADOWS any same-named schema
	// table / view / MV (matching read-side FROM shadowing). Resolve it ahead of the
	// schema dispatch below; a recursive target is rejected here with the structured
	// `recursive-cte` reason. The statement's CTEs are threaded into the planning
	// context so a sibling-CTE read in the source resolves. See docs/vu-operators.md
	// § Common Table Expressions.
	const cteTarget = resolveCteTarget(contextWithCTEs, stmt.table, stmt.withClause);
	if (cteTarget) {
		return buildViewMutation(contextForCteTarget(contextWithCTEs, stmt.withClause!, cteTarget.name), cteTarget, { op: 'insert', stmt });
	}

	// View- or materialized-view-mediated insert: if the target names an (updateable)
	// view or a materialized view, rewrite the statement to target the underlying base
	// table and re-plan through this same builder. A materialized view is a single-source
	// projection-and-filter (the row-time eligibility shape), so the same rewrite routes
	// write-through to its source `T`; the existing row-time maintenance hook then brings
	// the backing into sync within the statement. See docs/materialized-views.md
	// § Write boundary.
	// Dispatch order is load-bearing: a maintained table (derivation-bearing)
	// must hit the view-mutation rewrite, never the direct table write — its
	// contents are derived and only the source may be user-written.
	// An unqualified target resolves through the schema search path, exactly as an
	// unqualified read does (see `SchemaManager.findSchemaItem`).
	const insertTarget = ctx.schemaManager.findSchemaItem(stmt.table.name, stmt.table.schema, contextWithSchemaPath.schemaPath);
	const insertView = isViewSchema(insertTarget) ? insertTarget
		: (isMaintainedTable(insertTarget) ? maintainedTableViewLike(insertTarget) : undefined);
	if (insertView) {
		// Route through the view-mutation substrate: decompose to base op(s) and
		// re-plan each through the base-table builder, wrapped in a ViewMutationNode.
		// Single-source = one base op (byte-identical to the retired rewrite).
		return buildViewMutation(contextWithCTEs, insertView, { op: 'insert', stmt });
	}

	const tableRetrieve = buildTableReference({ type: 'table', table: stmt.table }, contextWithCTEs);
	const tableReference = tableRetrieve.tableRef; // Extract the actual TableReferenceNode

	// Backstop on the RESOLVED table: the dispatch above and buildTableReference
	// walk the same path today, so this should be unreachable — but they are two
	// resolvers, and a direct write to a maintained table would corrupt derived
	// contents. Keep the belt: route any that slips through to the same rewrite.
	const insertResolved = tableReference.tableSchema;
	if (isMaintainedTable(insertResolved)) {
		return buildViewMutation(contextWithCTEs, maintainedTableViewLike(insertResolved), { op: 'insert', stmt });
	}

	// Mutation context is driven by the TABLE's declaration, not by the statement: the
	// symbols are registered whenever the table declares any, so a default or CHECK that
	// reads one still resolves when the statement carries no `with context` clause. A
	// NOT NULL variable the statement omitted then fails at reference time with a message
	// naming the table and the variable — see building/mutation-context.ts.
	const contextAttributes = buildMutationContextAttributes(tableReference.tableSchema, stmt.contextValues);
	let contextScope: RegisteredScope | undefined;

	if (contextAttributes.length > 0) {
		// Create a new scope for mutation context. When a synthetic member insert
		// threads a produced-row NEW context, parent on it so context variables still
		// shadow the envelope's `new.<col>` (WITH CONTEXT precedence), while an envelope
		// column the member does not carry stays resolvable below.
		contextScope = new RegisteredScope(defaultRowContextScope ?? contextWithCTEs.scope);
		registerMutationContextSymbols(contextScope, contextAttributes);
	}

	// Build the context value expressions against the produced-row NEW context when a
	// synthetic member insert threads one, but NOT against `contextScope` itself: a
	// context value that reads a context variable has no context row to read it from
	// and fails at runtime with an opaque "no row context found". Resolving outward
	// instead reports it as the ordinary unresolved column it is, matching UPDATE and
	// DELETE, which build their values in the plain base scope.
	const mutationContextValues = buildMutationContextValues(
		defaultRowContextScope ? { ...contextWithCTEs, scope: defaultRowContextScope } : contextWithCTEs,
		contextAttributes,
		stmt.contextValues,
	);

	let targetColumns: ColumnDef[] = [];
	if (stmt.columns && stmt.columns.length > 0) {
		// Reject a column named more than once in the INSERT column list
		// (`insert into t (a, a) ...`). Without this, the positional row-expansion
		// resolves the duplicate silently (last-wins / a confusing shape) rather than
		// rejecting. This is also the guard that catches the view INSERT analogue: a
		// view whose two columns lower to one base column lands a duplicate in the
		// per-side `targetColumns` re-planned through here. Reject unconditionally,
		// matching the UPDATE-side decision (no value-agreement softening).
		const seenColumns = new Set<string>();
		for (const colName of stmt.columns) {
			const key = colName.toLowerCase();
			if (seenColumns.has(key)) {
				throw new QuereusError(
					`column '${colName}' specified more than once in INSERT into '${tableReference.tableSchema.name}'`,
					StatusCode.ERROR
				);
			}
			seenColumns.add(key);
		}
		// Explicit columns specified — validate none are generated
		targetColumns = stmt.columns.map((colName) => {
			const colIndex = tableReference.tableSchema.columnIndexMap.get(colName.toLowerCase());
			if (colIndex === undefined) {
				throw new QuereusError(
					`Column '${colName}' not found in table '${tableReference.tableSchema.name}'`,
					StatusCode.ERROR
				);
			}
			const colSchema = tableReference.tableSchema.columns[colIndex];
			if (colSchema.generated) {
				throw new QuereusError(
					`Cannot INSERT into generated column '${colName}'`,
					StatusCode.ERROR
				);
			}
			return columnSchemaToDef(colName, colSchema);
		});
	} else {
		// No explicit columns - default to all non-generated table columns in order
		targetColumns = tableReference.tableSchema.columns
			.filter(col => !col.generated)
			.map(col => columnSchemaToDef(col.name, col));
	}

	// Build the INSERT source — a unified QueryExpr (SELECT/VALUES/DML w/ RETURNING).
	// Each branch produces a relational plan that the row-expansion projection
	// then aligns to the target table columns. Every branch builds on
	// `contextWithCTEs`, so the statement's CTEs (its own and any inherited) are
	// visible to a SELECT source, to a scalar subquery inside a VALUES row, and to a
	// nested DML source alike.
	let sourceNode: RelationalPlanNode;
	if (preBuiltSource) {
		// Multi-source view-insert decomposition: the source is a projection over the
		// shared-surrogate envelope, already aligned positionally to targetColumns.
		sourceNode = preBuiltSource;
		checkColumnsAssignable(sourceNode.getType().columns, targetColumns, stmt);
	} else switch (stmt.source.type) {
		case 'values': {
			// Bare VALUES — no source-side column type-check; the row-expansion
			// projection handles column-count and per-column type coercion.
			sourceNode = buildValuesStmt(contextWithCTEs, stmt.source);
			const sourceCols = sourceNode.getType().columns;
			if (sourceCols.length !== targetColumns.length) {
				throw new QuereusError(`Column count mismatch in VALUES clause. Expected ${targetColumns.length} columns, got ${sourceCols.length}.`, StatusCode.ERROR, undefined, stmt.loc?.start.line, stmt.loc?.start.column);
			}
			break;
		}
		case 'select': {
			const selectPlan = buildSelectStmt(contextWithCTEs, stmt.source);
			if (selectPlan.getType().typeClass !== 'relation') {
				throw new QuereusError('SELECT statement in INSERT did not produce a relational plan.', StatusCode.INTERNAL, undefined, stmt.loc?.start.line, stmt.loc?.start.column);
			}
			sourceNode = selectPlan as RelationalPlanNode;
			checkColumnsAssignable(sourceNode.getType().columns, targetColumns, stmt);
			break;
		}
		case 'insert': {
			// DML-as-source: the inner DML's RETURNING clause produces the rows
			// consumed by the outer INSERT. The inner is built through its
			// standard builder; the outer's row-expansion projection aligns the
			// RETURNING columns to the outer target columns.
			sourceNode = buildInsertStmt(contextWithCTEs, stmt.source) as RelationalPlanNode;
			checkColumnsAssignable(sourceNode.getType().columns, targetColumns, stmt);
			break;
		}
		case 'update': {
			sourceNode = buildUpdateStmt(contextWithCTEs, stmt.source) as RelationalPlanNode;
			checkColumnsAssignable(sourceNode.getType().columns, targetColumns, stmt);
			break;
		}
		case 'delete': {
			sourceNode = buildDeleteStmt(contextWithCTEs, stmt.source) as RelationalPlanNode;
			checkColumnsAssignable(sourceNode.getType().columns, targetColumns, stmt);
			break;
		}
	}

	// The context for the table's OWN schema-authored SQL (column defaults, generated
	// columns, CHECK constraints, FK probes). Derived once here rather than per call
	// site: it clears the CTE namespace so none of that SQL can bind a statement's common
	// table expressions, and narrows the schema path to the target's own schema so every
	// kind resolves bare relation names identically — the statement's `with schema` path
	// is deliberately irrelevant to all of them.
	const schemaAuthoredCtx = schemaAuthoredContext(ctx, tableReference.tableSchema.schemaName);

	// ORTHOGONAL ROW EXPANSION: Apply uniform row expansion to map any source to table structure with defaults
	const expandedSourceNode = createRowExpansionProjection(schemaAuthoredCtx, sourceNode, targetColumns, tableReference, contextScope, defaultRowContextScope);

	// Update targetColumns to reflect all table columns since we've expanded the source
	const finalTargetColumns = tableReference.tableSchema.columns.map(col => columnSchemaToDef(col.name, col));

	// Create OLD/NEW attributes for INSERT (OLD = all NULL, NEW = actual values)
	const oldAttributes = tableReference.tableSchema.columns.map((col) => ({
		id: PlanNode.nextAttrId(),
		name: col.name,
		// OLD values are always NULL for INSERT
		type: columnSchemaToScalarType(col, { nullable: true }),
		sourceRelation: `OLD.${tableReference.tableSchema.name}`
	}));

	const newAttributes = tableReference.tableSchema.columns.map((col) => ({
		id: PlanNode.nextAttrId(),
		name: col.name,
		type: columnSchemaToScalarType(col),
		sourceRelation: `NEW.${tableReference.tableSchema.name}`
	}));

	const { oldRowDescriptor, newRowDescriptor, flatRowDescriptor } = buildOldNewRowDescriptors(oldAttributes, newAttributes);

	// Build context descriptor if we have context attributes
	const contextDescriptor: RowDescriptor | undefined = contextAttributes.length > 0 ? [] : undefined;
	if (contextDescriptor) {
		contextAttributes.forEach((attr, index) => {
			contextDescriptor[attr.id] = index;
		});
	}

	// Build constraint checks at plan time
	const constraintChecks = buildConstraintChecks(
		schemaAuthoredCtx,
		tableReference.tableSchema,
		RowOpFlag.INSERT,
		oldAttributes,
		newAttributes,
		flatRowDescriptor,
		contextAttributes,
		extraConstraints
	);

	// Build FK constraint checks if foreign_keys pragma is enabled
	if (ctx.db.options.getBooleanOption('foreign_keys')) {
		const fkChecks = buildChildSideFKChecks(
			schemaAuthoredCtx, tableReference.tableSchema, RowOpFlag.INSERT,
			oldAttributes, newAttributes, contextAttributes
		);
		constraintChecks.push(...fkChecks);
	}

	// Pre-build DEFAULT evaluators for NOT NULL columns. Used by REPLACE to
	// substitute the default when the user supplied NULL.
	const notNullDefaults = buildNotNullDefaults(
		schemaAuthoredCtx, tableReference.tableSchema, newAttributes, contextAttributes, defaultRowContextScope
	);

	const insertNode = new InsertNode(
		ctx.scope,
		tableReference,
		finalTargetColumns,
		expandedSourceNode,
		flatRowDescriptor,
		mutationContextValues.size > 0 ? mutationContextValues : undefined,
		contextAttributes.length > 0 ? contextAttributes : undefined,
		contextDescriptor
	);

	const constraintCheckNode = new ConstraintCheckNode(
		ctx.scope,
		insertNode,
		tableReference,
		RowOpFlag.INSERT,
		oldRowDescriptor,
		newRowDescriptor,
		flatRowDescriptor,
		constraintChecks,
		mutationContextValues.size > 0 ? mutationContextValues : undefined,
		contextAttributes.length > 0 ? contextAttributes : undefined,
		contextDescriptor,
		stmt.onConflict,
		notNullDefaults.length > 0 ? notNullDefaults : undefined
	);

	// Build UPSERT clause plans if present
	let upsertClausePlans: UpsertClausePlan[] | undefined;
	if (stmt.upsertClauses && stmt.upsertClauses.length > 0) {
		// User-authored clause: built on the CTE-aware context so a `do update set
		// w = (select … from c)` / `where (select … from c)` resolves the statement's
		// CTEs, and so a `with schema` path reaches those subqueries.
		upsertClausePlans = buildUpsertClausePlans(
			contextWithCTEs,
			stmt.upsertClauses,
			tableReference.tableSchema,
			newAttributes
		);
	}

	// UPDATE-shaped validation for the `on conflict … do update` arm. The arm composes
	// the row it writes inside the DML executor and calls vtab.update directly, so that
	// row never passes through the INSERT-shaped ConstraintCheckNode above. Build here
	// exactly what buildUpdateStmt would build for the equivalent plain UPDATE, so the
	// two spellings of the same write are refused (or accepted) identically.
	const upsertUpdateValidation = upsertClausePlans?.some(clause => clause.action === 'update')
		? buildUpsertUpdateValidation(ctx, schemaAuthoredCtx, tableReference, contextAttributes, lensRouted)
		: undefined;

	// Add DML executor node to perform the actual database insert operations
	const dmlExecutorNode = new DmlExecutorNode(
		ctx.scope,
		constraintCheckNode,
		tableReference,
		'insert',
		stmt.onConflict,
		mutationContextValues.size > 0 ? mutationContextValues : undefined,
		contextAttributes.length > 0 ? contextAttributes : undefined,
		contextDescriptor,
		upsertClausePlans,
		lensRouted,
		upsertUpdateValidation
	);

	const resultNode: RelationalPlanNode = dmlExecutorNode;

	if (stmt.returning && stmt.returning.length > 0) {
		// Create returning scope with OLD/NEW attribute access. Parented on the CTE-aware
		// context's scope and built against that context, so a RETURNING subquery sees the
		// statement's CTEs and its `with schema` path — matching buildUpdateStmt.
		const returningScope = new RegisteredScope(contextWithCTEs.scope);

		// Register OLD.* symbols (always NULL for INSERT)
		oldAttributes.forEach((attr, columnIndex) => {
			const tableColumn = tableReference.tableSchema.columns[columnIndex];
			returningScope.registerSymbol(`old.${tableColumn.name.toLowerCase()}`, (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, columnIndex)
			);
		});

		// Register NEW.* symbols and unqualified column names (default to NEW)
		newAttributes.forEach((attr, columnIndex) => {
			const tableColumn = tableReference.tableSchema.columns[columnIndex];

			// NEW.column
			returningScope.registerSymbol(`new.${tableColumn.name.toLowerCase()}`, (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, columnIndex)
			);

			// Unqualified column (defaults to NEW)
			returningScope.registerSymbol(tableColumn.name.toLowerCase(), (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, columnIndex)
			);

			// Table-qualified form (table.column -> NEW)
			const tblQualified = `${tableReference.tableSchema.name.toLowerCase()}.${tableColumn.name.toLowerCase()}`;
			returningScope.registerSymbol(tblQualified, (exp, s) =>
				new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, columnIndex)
			);
		});

		// Build RETURNING projections in the OLD/NEW context. A `*` / `t.*` expands
		// in place (so `returning id, *` keeps surrounding columns in position).
		const returningProjections: ReturningProjection[] = [];
		for (const rc of stmt.returning) {
			if (rc.type === 'all') {
				// INSERT has no alias (only inline-subquery targets do, and those route
				// through the view path); the star inherits NEW via the returning scope.
				returningProjections.push(...expandReturningStar(contextWithCTEs, rc, returningScope, tableReference.tableSchema, undefined));
				continue;
			}

			// Infer alias from column name if not explicitly provided.
			// Preserve the spelling the user wrote so quoted identifiers like
			// [Name] / "Name" round-trip to the result column name unchanged.
			let alias = rc.alias;
			if (!alias && rc.expr.type === 'column') {
				alias = rc.expr.table
					? `${rc.expr.table}.${rc.expr.name}`
					: rc.expr.name;
			}

			// Validate qualifier usage on the AST before column resolution so the
			// OLD-in-INSERT guard fires before any "column not found" error.
			validateReturningQualifiers(rc.expr, 'INSERT');

			returningProjections.push({
				node: buildExpression({ ...contextWithCTEs, scope: returningScope }, rc.expr) as ScalarPlanNode,
				alias: alias
			});
		}

		return new ReturningNode(ctx.scope, dmlExecutorNode, returningProjections);
	}

	return new SinkNode(ctx.scope, resultNode, 'insert');
}
