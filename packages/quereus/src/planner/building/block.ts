import { BlockNode } from '../nodes/block.js';
import * as AST from '../../parser/ast.js';
import type { PlanNode } from '../nodes/plan-node.js';
import { buildSelectStmt } from './select.js';
import type { PlanningContext } from '../planning-context.js';
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
	const plannedStatements = statements.map((stmt) => {
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
	}).filter(p => p !== undefined) as PlanNode[]; // Ensure we only have valid PlanNodes and cast

    // The final BatchNode for the entire batch.
    // Its scope is batchParameterScope, and it contains all successfully planned statements.
	return new BlockNode(ctx.scope, plannedStatements, { ...ctx.parameters });
}
