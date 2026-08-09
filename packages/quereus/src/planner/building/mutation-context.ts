import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import type { MutationContextDefinition, TableSchema } from '../../schema/table.js';
import { PlanNode, type Attribute, type ScalarPlanNode } from '../nodes/plan-node.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import type { RegisteredScope } from '../scopes/registered.js';
import type { ReferenceCallback } from '../scopes/scope.js';
import { buildExpression } from './expression.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

/**
 * One {@link Attribute} per declared mutation-context variable of the table being
 * written. Attributes are built from `TableSchema.mutationContext` — the *schema* —
 * never from the statement's `with context` clause, so the set and its order are the
 * same whether or not the statement supplied an envelope. That makes the
 * `contextDescriptor` ↔ evaluated-context-row alignment structural: every declared
 * variable always has exactly one attribute and exactly one value expression.
 */
export interface MutationContextAttribute extends Attribute {
	/** The declared variable this attribute stands for. */
	readonly contextVar: MutationContextDefinition;
	/** `<schema>.<table>` of the declaring table, for the missing-value diagnostic. */
	readonly tableLabel: string;
	/** Whether the statement's `with context` clause named this variable. */
	readonly supplied: boolean;
}

/**
 * The statement omitted a NOT NULL context variable that an expression is trying to
 * read. Raised at *reference* time (from the symbol resolver) rather than when the
 * symbols are registered: a table may declare a variable that a given statement's
 * defaults and constraints never read, and such a write is legal with no envelope.
 */
function missingContextValueError(attr: MutationContextAttribute): QuereusError {
	const varName = attr.contextVar.name;
	return new QuereusError(
		`table '${attr.tableLabel}' requires mutation context variable '${varName}'; ` +
		`supply it with \`with context ${varName} = …\``,
		StatusCode.ERROR,
	);
}

/**
 * Builds the context attributes for a write to `tableSchema`.
 *
 * Returns an empty array when the table declares no mutation context, which is the
 * signal every caller uses to skip context wiring entirely.
 */
export function buildMutationContextAttributes(
	tableSchema: TableSchema,
	suppliedValues: ReadonlyArray<AST.ContextAssignment> | undefined,
): MutationContextAttribute[] {
	const declared = tableSchema.mutationContext;
	if (!declared || declared.length === 0) return [];

	// Names the statement supplied. Matched case-insensitively, as identifiers are
	// everywhere else — the scope keys are lower-cased too.
	const suppliedNames = new Set((suppliedValues ?? []).map(a => a.name.toLowerCase()));
	const tableLabel = `${tableSchema.schemaName}.${tableSchema.name}`;

	return declared.map(contextVar => ({
		id: PlanNode.nextAttrId(),
		name: contextVar.name,
		type: {
			typeClass: 'scalar' as const,
			// NOTE: `notNull` is a *declaration*, not a runtime guarantee — nothing rejects a
			// supplied value expression that evaluates to NULL, so `nullable: false` here is a
			// static claim the runtime does not enforce. Harmless today (no rule folds on a
			// context attribute's nullability); if one ever does, either enforce NOT NULL on
			// the evaluated context row or widen this to `nullable: true`.
			logicalType: contextVar.logicalType,
			nullable: !contextVar.notNull,
			isReadOnly: true,
		},
		sourceRelation: `context.${tableSchema.name}`,
		contextVar,
		tableLabel,
		supplied: suppliedNames.has(contextVar.name.toLowerCase()),
	}));
}

/**
 * Registers `<name>` and `context.<name>` for every declared context variable in
 * `scope`. Callers register context symbols BEFORE column symbols so context
 * variables shadow same-named columns (the documented `with context` precedence) —
 * see {@link mutationContextVarNames} for the bare column names a caller must then
 * leave unregistered.
 */
export function registerMutationContextSymbols(
	scope: RegisteredScope,
	contextAttributes: ReadonlyArray<MutationContextAttribute>,
): void {
	contextAttributes.forEach((attr, contextVarIndex) => {
		const varNameLower = attr.contextVar.name.toLowerCase();

		const reference: ReferenceCallback = attr.supplied || !attr.contextVar.notNull
			? (exp, s) => new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, contextVarIndex)
			: () => { throw missingContextValueError(attr); };

		scope.registerSymbol(varNameLower, reference);
		scope.registerSymbol(`context.${varNameLower}`, reference);
	});
}

/**
 * The lower-cased bare names claimed by the context variables. A scope that registers
 * both context variables and columns must skip the *unqualified* form for these names —
 * {@link RegisteredScope.registerSymbol} throws on a duplicate key, and the context
 * variable is the one that must win. The qualified `new.<col>` / `old.<col>` forms stay
 * available, so the shadowed column is still reachable.
 */
export function mutationContextVarNames(
	contextAttributes: ReadonlyArray<MutationContextAttribute>,
): ReadonlySet<string> {
	return new Set(contextAttributes.map(attr => attr.contextVar.name.toLowerCase()));
}

/**
 * Builds one value expression per declared context variable, keyed by the declared
 * name (the key {@link MutationContextAttribute.name} and the emitters look up).
 *
 * A variable the statement supplied gets its value expression; one it omitted gets a
 * NULL literal. Omission is only *reachable* for a nullable variable — a NOT NULL one
 * that any default or constraint reads has already failed at reference time via
 * {@link registerMutationContextSymbols} — but the slot is filled either way so the
 * evaluated context row always lines up with `contextDescriptor`.
 *
 * Names the statement supplied that the table does NOT declare are ignored, not
 * rejected: view decomposition forwards one envelope verbatim to every member
 * statement, so a member routinely receives values for variables it never declared
 * (see docs/vu-mutation-context.md).
 */
export function buildMutationContextValues(
	ctx: PlanningContext,
	contextAttributes: ReadonlyArray<MutationContextAttribute>,
	suppliedValues: ReadonlyArray<AST.ContextAssignment> | undefined,
): Map<string, ScalarPlanNode> {
	const values = new Map<string, ScalarPlanNode>();
	if (contextAttributes.length === 0) return values;

	const supplied = new Map<string, AST.ContextAssignment>();
	for (const assignment of suppliedValues ?? []) {
		supplied.set(assignment.name.toLowerCase(), assignment);
	}

	for (const attr of contextAttributes) {
		const assignment = supplied.get(attr.contextVar.name.toLowerCase());
		const valueExpr: AST.Expression = assignment
			? assignment.value
			: { type: 'literal', value: null };
		values.set(attr.name, buildExpression(ctx, valueExpr) as ScalarPlanNode);
	}

	return values;
}
