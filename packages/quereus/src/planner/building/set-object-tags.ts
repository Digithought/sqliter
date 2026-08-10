import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import type { VoidNode } from '../nodes/plan-node.js';
import { SetObjectTagsNode, type SetObjectTagsKind, type SetObjectTagsMutation } from '../nodes/set-object-tags-node.js';
import { validateReservedTags, type TagSite } from '../../schema/reserved-tags.js';
import { raiseReservedTagDiagnostics } from '../../schema/reserved-tags-policy.js';

/**
 * Shared builder for `ALTER VIEW / MATERIALIZED VIEW / INDEX … {SET|ADD|DROP}
 * TAGS`. `SET`/`ADD TAGS` (both `setTags` actions) validate any reserved
 * `quereus.*` tags at the site that matches the object kind (view / materialized
 * view → `view-ddl`, index → `physical-index`) so a typo fails loudly at
 * plan-build time — the same registry the CREATE and declarative paths route
 * through. `DROP TAGS` removes by key and does NO value validation (dropping a
 * reserved override is legitimate). An unqualified name resolves to the current
 * default schema (matching the CREATE / DROP MATERIALIZED VIEW builders) so an
 * unqualified ALTER under a switched current schema targets the right object
 * rather than always looking in `main`.
 */
function buildSetObjectTags(
	ctx: PlanningContext,
	objectKind: SetObjectTagsKind,
	name: AST.IdentifierExpr,
	action: AST.AlterObjectTagsAction,
	site: TagSite,
): VoidNode {
	let mutation: SetObjectTagsMutation;
	if (action.type === 'setTags') {
		raiseReservedTagDiagnostics(
			validateReservedTags(action.tags, site),
			{ log: () => { /* warnings (e.g. empty ack rationale) never block */ } },
		);
		mutation = { op: action.mode, tags: action.tags };
	} else {
		// DROP TAGS: no value validation — removing a reserved key is legitimate.
		mutation = { op: 'drop', keys: action.keys };
	}
	const schemaName = name.schema || ctx.schemaManager.getCurrentSchemaName();
	return new SetObjectTagsNode(ctx.scope, objectKind, schemaName, name.name, mutation);
}

export function buildAlterViewStmt(ctx: PlanningContext, stmt: AST.AlterViewStmt): VoidNode {
	return buildSetObjectTags(ctx, 'view', stmt.name, stmt.action, 'view-ddl');
}

export function buildAlterMaterializedViewStmt(ctx: PlanningContext, stmt: AST.AlterMaterializedViewStmt): VoidNode {
	return buildSetObjectTags(ctx, 'materializedView', stmt.name, stmt.action, 'view-ddl');
}

export function buildAlterIndexStmt(ctx: PlanningContext, stmt: AST.AlterIndexStmt): VoidNode {
	return buildSetObjectTags(ctx, 'index', stmt.name, stmt.action, 'physical-index');
}
