import { BlockNode } from '../nodes/block.js';
import * as AST from '../../parser/ast.js';
import { isRelationalNode, type PlanNode, type TableDescriptor } from '../nodes/plan-node.js';
import { buildSelectStmt } from './select.js';
import type { PlanningContext } from '../planning-context.js';
import { CTENode } from '../nodes/cte-node.js';
import { SequenceNode } from '../nodes/sequence-node.js';
import { SinkNode } from '../nodes/sink-node.js';
import { buildWithClause, isDataModifyingCte } from './with.js';
import { buildCreateTableStmt } from './ddl.js';
import { buildCreateIndexStmt } from './ddl.js';
import { buildDropTableStmt } from './drop-table.js';
import { buildCreateViewStmt } from './create-view.js';
import { buildDropViewStmt } from './drop-view.js';
import {
	buildCreateMaterializedViewStmt,
	buildRefreshMaterializedViewStmt,
	buildDropMaterializedViewStmt,
} from './materialized-view.js';
import { buildCreateAssertionStmt } from './create-assertion.js';
import { buildDropAssertionStmt } from './drop-assertion.js';
import { buildDropIndexStmt } from './drop-index.js';
import { buildInsertStmt } from './insert.js';
import { buildUpdateStmt } from './update.js';
import { buildDeleteStmt } from './delete.js';
import { buildAlterTableStmt } from './alter-table.js';
import { buildAlterViewStmt, buildAlterMaterializedViewStmt, buildAlterIndexStmt } from './set-object-tags.js';
import { buildBeginStmt, buildCommitStmt, buildRollbackStmt, buildSavepointStmt, buildReleaseStmt } from './transaction.js';
import { buildPragmaStmt } from './pragma.js';
import { buildAnalyzeStmt } from './analyze.js';
import { buildValuesStmt } from './select.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { buildDeclareSchemaStmt, buildDeclareLensStmt, buildDiffSchemaStmt, buildApplySchemaStmt, buildExplainSchemaStmt } from './declare-schema.js';

export function buildBlock(ctx: PlanningContext, statements: AST.Statement[]): BlockNode {
	// Mark these statements' own leading WITH clauses before anything is built: a
	// data-modifying member is legal only there, and `buildWithClause` rejects one
	// anywhere else (see its comment). Used for `attachUnreferencedDmlCtes` too — that
	// rebuild goes through `buildWithClause` on the SAME clause object and must stay
	// allowed.
	//
	// NOTE: several analysis paths re-plan a STORED body as if it were a standalone
	// top-level statement — `db._buildPlan([view.selectAst])` in `func/builtins/schema.ts`,
	// `planner/analysis/assertion-plan.ts`, `core/database-materialized-views-plan-builders.ts`,
	// `runtime/emit/materialized-view-helpers.ts`, `schema/lens-prover.ts`,
	// `func/builtins/explain.ts`. Those calls mark the body's own clause top-level, so a body
	// that ALREADY contains a data-modifying member would still be accepted there.
	// Unreachable for anything created after this gate landed (definition-time planning goes
	// through a nested context and is rejected); reachable only for a definition persisted by
	// an older build. Not worth a "this is a stored body" flag on `_buildPlan`.
	const blockCtx: PlanningContext = { ...ctx, topLevelWithClauses: collectTopLevelWithClauses(statements) };

	const plannedStatements = statements.map((stmt) => {
		const planned = buildStatement(blockCtx, stmt);
		return planned === undefined ? undefined : attachUnreferencedDmlCtes(blockCtx, stmt, planned);
	}).filter(p => p !== undefined) as PlanNode[]; // Ensure we only have valid PlanNodes and cast

    // The final BatchNode for the entire batch.
    // Its scope is batchParameterScope, and it contains all successfully planned statements.
	return new BlockNode(ctx.scope, plannedStatements, { ...ctx.parameters });
}

/** The leading `with` clause of each statement in this block, by AST object identity. */
function collectTopLevelWithClauses(statements: AST.Statement[]): ReadonlySet<AST.WithClause> {
	const clauses = new Set<AST.WithClause>();
	for (const stmt of statements) {
		const withClause = (stmt as { withClause?: AST.WithClause }).withClause;
		if (withClause) clauses.add(withClause);
	}
	return clauses;
}

function buildStatement(ctx: PlanningContext, stmt: AST.Statement): PlanNode | undefined {
	switch (stmt.type) {
		case 'select':
			// buildSelectStmt returns a BatchNode, which is a PlanNode.
			return buildSelectStmt(ctx, stmt as AST.SelectStmt);
		case 'createTable':
			return buildCreateTableStmt(ctx, stmt as AST.CreateTableStmt);
		case 'createIndex':
			return buildCreateIndexStmt(ctx, stmt as AST.CreateIndexStmt);
		case 'createView':
			return buildCreateViewStmt(ctx, stmt as AST.CreateViewStmt);
		case 'createMaterializedView':
			return buildCreateMaterializedViewStmt(ctx, stmt as AST.CreateMaterializedViewStmt);
		case 'refreshMaterializedView':
			return buildRefreshMaterializedViewStmt(ctx, stmt as AST.RefreshMaterializedViewStmt);
		case 'createAssertion':
			return buildCreateAssertionStmt(ctx, stmt as AST.CreateAssertionStmt);
		case 'drop': {
			const dropStmt = stmt as AST.DropStmt;
			if (dropStmt.objectType === 'table') {
				return buildDropTableStmt(ctx, dropStmt);
			} else if (dropStmt.objectType === 'view') {
				return buildDropViewStmt(ctx, dropStmt);
			} else if (dropStmt.objectType === 'materializedView') {
				return buildDropMaterializedViewStmt(ctx, dropStmt);
			} else if (dropStmt.objectType === 'assertion') {
				return buildDropAssertionStmt(ctx, dropStmt);
			} else if (dropStmt.objectType === 'index') {
				return buildDropIndexStmt(ctx, dropStmt);
			} else if (dropStmt.objectType === 'trigger') {
				quereusError(
					`DROP TRIGGER is not supported`,
					StatusCode.UNSUPPORTED,
					undefined,
					dropStmt
				);
			}
			break;
		}
		case 'insert':
			return buildInsertStmt(ctx, stmt as AST.InsertStmt);
		case 'update':
			return buildUpdateStmt(ctx, stmt as AST.UpdateStmt);
		case 'delete':
			return buildDeleteStmt(ctx, stmt as AST.DeleteStmt);
		case 'begin':
			return buildBeginStmt(ctx, stmt as AST.BeginStmt);
		case 'commit':
			return buildCommitStmt(ctx, stmt as AST.CommitStmt);
		case 'rollback':
			return buildRollbackStmt(ctx, stmt as AST.RollbackStmt);
		case 'savepoint':
			return buildSavepointStmt(ctx, stmt as AST.SavepointStmt);
		case 'release':
			return buildReleaseStmt(ctx, stmt as AST.ReleaseStmt);
		case 'pragma':
			return buildPragmaStmt(ctx, stmt as AST.PragmaStmt);
		case 'analyze':
			return buildAnalyzeStmt(ctx, stmt as AST.AnalyzeStmt);
		case 'alterTable':
			return buildAlterTableStmt(ctx, stmt as AST.AlterTableStmt);
		case 'alterView':
			return buildAlterViewStmt(ctx, stmt as AST.AlterViewStmt);
		case 'alterMaterializedView':
			return buildAlterMaterializedViewStmt(ctx, stmt as AST.AlterMaterializedViewStmt);
		case 'alterIndex':
			return buildAlterIndexStmt(ctx, stmt as AST.AlterIndexStmt);
		case 'values':
			return buildValuesStmt(ctx, stmt as AST.ValuesStmt);
		case 'declareSchema':
			return buildDeclareSchemaStmt(ctx, stmt);
		case 'declareLens':
			return buildDeclareLensStmt(ctx, stmt);
		case 'diffSchema':
			return buildDiffSchemaStmt(ctx, stmt);
		case 'applySchema':
			return buildApplySchemaStmt(ctx, stmt);
		case 'explainSchema':
			return buildExplainSchemaStmt(ctx, stmt);
		default:
			// Throw an exception for unsupported statement types
			quereusError(
				`Unsupported statement type: ${(stmt as AST.Statement).type}`,
				StatusCode.UNSUPPORTED,
				undefined,
				stmt
			);
	}
}

/**
 * Guarantee the write of every data-modifying `with` member the statement never
 * references. A member enters the plan only when something reads it, but an
 * `insert`/`update`/`delete` member is a stated effect of the statement — SQLite
 * and PostgreSQL both perform it whether or not anything reads the block.
 *
 * This is the ONE safe attachment site: `buildBlock` is the single entry for
 * user statements (`Database._buildPlan` is its only caller), sees both the
 * statement AST and the finished plan, and runs once per top-level statement.
 * Every site inside the statement builders is re-entered by the view
 * write-through path (and once per base member by a multi-source decomposition),
 * so a per-builder attachment would fan the sink out N times. A `with` clause on
 * a NESTED statement (a sub-select's own clause, a stored view body) is out of
 * scope, and that boundary is now ENFORCED rather than merely unimplemented:
 * `buildWithClause` rejects a data-modifying member in any clause `buildBlock`
 * did not mark top-level (PostgreSQL rejects the same shapes), so no position
 * exists where a write would go unowned.
 *
 * Mechanics: each member's runtime identity (`CTENode.tableDescriptor`) is
 * memoized per source AST member for the whole statement build
 * (`PlanningContext.cteDescriptors`), so a member whose descriptor is absent
 * from the built plan is provably unreferenced. The clause is then rebuilt —
 * required because a member may read an earlier sibling — and each unreferenced
 * data-modifying member's node is Sink-wrapped and sequenced AHEAD of the
 * statement (a trailing effect could be skipped by a main abandoned early, e.g.
 * `limit 0`). The rebuild cannot double a referenced member's write: its rebuilt
 * `CTENode` shares the referenced one's descriptor, hence its one buffer.
 */
function attachUnreferencedDmlCtes(ctx: PlanningContext, stmt: AST.Statement, plan: PlanNode): PlanNode {
	const stmtAst = stmt as { withClause?: AST.WithClause; schemaPath?: string[] };
	const withClause = stmtAst.withClause;
	if (!withClause) return plan;

	const dmlMembers = withClause.ctes.filter(isDataModifyingCte);
	if (dmlMembers.length === 0) return plan;

	const reachable = collectCteDescriptors(plan);
	const unreferenced = dmlMembers.filter(cte => {
		const descriptor = ctx.cteDescriptors.get(cte);
		return descriptor !== undefined && !reachable.has(descriptor);
	});
	if (unreferenced.length === 0) return plan;

	// Rebuild the whole clause in order (a member may read an earlier sibling);
	// the descriptor memo makes this safe — see the doc comment above. The
	// statement's own WITH SCHEMA path applies to its clause, so mirror the
	// statement builders' `contextWithSchemaPath`.
	const rebuildCtx = stmtAst.schemaPath ? { ...ctx, schemaPath: stmtAst.schemaPath } : ctx;
	const rebuilt = buildWithClause(rebuildCtx, withClause);
	const sinks = unreferenced.map(cte => {
		const node = rebuilt.get(cte.name.toLowerCase());
		if (!node || !isRelationalNode(node)) {
			quereusError(`CTE '${cte.name}' missing from rebuilt WITH clause`, StatusCode.INTERNAL, undefined, stmt);
		}
		return new SinkNode(ctx.scope, node, `unreferenced-cte ${cte.name}`);
	});

	return new SequenceNode(ctx.scope, sinks, plan);
}

/** Every `CTENode` runtime identity reachable from `plan`. Walks `getRelations`
 *  as well as `getChildren` so DML write targets (outside `getChildren`) are
 *  covered — mirrors `collectTableRefs` in analysis/change-scope.ts. */
function collectCteDescriptors(plan: PlanNode): Set<TableDescriptor> {
	const descriptors = new Set<TableDescriptor>();
	const visited = new Set<PlanNode>();
	function walk(node: PlanNode): void {
		if (visited.has(node)) return;
		visited.add(node);
		if (node instanceof CTENode) descriptors.add(node.tableDescriptor);
		for (const c of node.getChildren()) walk(c as unknown as PlanNode);
		for (const r of node.getRelations()) walk(r as unknown as PlanNode);
	}
	walk(plan);
	return descriptors;
}
