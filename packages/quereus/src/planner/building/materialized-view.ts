import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import {
	CreateMaterializedViewNode,
	RefreshMaterializedViewNode,
	DropMaterializedViewNode,
} from '../nodes/materialized-view-nodes.js';
import { planViewBody } from './create-view.js';
import { astToString } from '../../emit/ast-stringify.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { normalizeBackingModule } from '../../schema/view.js';

/**
 * Builds a plan node for CREATE MATERIALIZED VIEW. Validates the body (reusing
 * the CREATE VIEW gate so DML bodies and arity mismatches are rejected with the
 * same diagnostics) and gates the `using <module>(...)` backing clause on the
 * backing-host capability: any registered module implementing `getBackingHost`
 * can host the backing table (memory is the default).
 */
export function buildCreateMaterializedViewStmt(ctx: PlanningContext, stmt: AST.CreateMaterializedViewStmt): CreateMaterializedViewNode {
	// Canonical schemaName (see SchemaManager.canonicalSchemaName) — it flows into
	// the stored MV record and its backing TableSchema via materializeView.
	const sm = ctx.db.schemaManager;
	const schemaName = stmt.view.schema ? sm.canonicalSchemaName(stmt.view.schema) : sm.getCurrentSchemaName();
	const viewName = stmt.view.name;

	const backing = normalizeBackingModule(stmt.moduleName, stmt.moduleArgs);
	const moduleInfo = ctx.db.schemaManager.getModule(backing.moduleName);
	if (!moduleInfo?.module) {
		throw new QuereusError(
			`no virtual table module named '${backing.moduleName}'`,
			StatusCode.ERROR,
			undefined,
			stmt.view.loc?.start.line,
			stmt.view.loc?.start.column,
		);
	}
	if (!moduleInfo.module.getBackingHost) {
		throw new QuereusError(
			`module '${backing.moduleName}' cannot host a materialized-view backing table (it does not implement the backing-host capability)`,
			StatusCode.UNSUPPORTED,
			undefined,
			stmt.view.loc?.start.line,
			stmt.view.loc?.start.column,
		);
	}

	// Validate the body: planViewBody rejects DML bodies and yields the body's
	// relational shape. Always run it so a DML body is rejected at plan time.
	// The body plans under the MV's home-schema path so its unqualified source
	// names resolve next to the MV, not against the creating statement's path.
	const planned = planViewBody(ctx, viewName, stmt.select, schemaName);

	if (stmt.columns && stmt.columns.length > 0) {
		const bodyArity = planned.getAttributes().length;
		if (stmt.columns.length !== bodyArity) {
			throw new QuereusError(
				`Materialized view '${viewName}' has ${stmt.columns.length} declared columns but body produces ${bodyArity}`,
				StatusCode.ERROR
			);
		}
	}

	// Row-time eligibility (the body must be a passthrough projection of a single
	// keyed source) is checked entirely at runtime in the create emitter, against
	// the optimized/analyzed body — there is no build-time AST rejection to do here.
	// The canonical DDL renders on demand from the unified record (normalized
	// module identity included), so the node carries only the body SQL.
	const bodySql = astToString(stmt.select);

	return new CreateMaterializedViewNode(
		ctx.scope,
		viewName,
		schemaName,
		stmt.ifNotExists,
		stmt.columns,
		stmt.select,
		bodySql,
		stmt.tags ? Object.freeze({ ...stmt.tags }) : undefined,
		backing.storedModuleName,
		backing.storedModuleArgs,
	);
}

/** Builds a plan node for REFRESH MATERIALIZED VIEW. */
export function buildRefreshMaterializedViewStmt(ctx: PlanningContext, stmt: AST.RefreshMaterializedViewStmt): RefreshMaterializedViewNode {
	const sm = ctx.db.schemaManager;
	const schemaName = stmt.name.schema ? sm.canonicalSchemaName(stmt.name.schema) : sm.getCurrentSchemaName();
	return new RefreshMaterializedViewNode(ctx.scope, stmt.name.name, schemaName);
}

/** Builds a plan node for DROP MATERIALIZED VIEW. */
export function buildDropMaterializedViewStmt(ctx: PlanningContext, stmt: AST.DropStmt): DropMaterializedViewNode {
	const sm = ctx.db.schemaManager;
	const schemaName = stmt.name.schema ? sm.canonicalSchemaName(stmt.name.schema) : sm.getCurrentSchemaName();
	return new DropMaterializedViewNode(ctx.scope, stmt.name.name, schemaName, stmt.ifExists);
}
