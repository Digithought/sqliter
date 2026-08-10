import { createLogger } from '../common/logger.js';
import type * as AST from './ast.js';

const log = createLogger('parser:visitor'); // Create logger instance
const warnLog = log.extend('warn');


/**
 * Defines the callbacks for the AST visitor.
 * Functions can return false to stop traversal down that branch.
 */
export interface AstVisitorCallbacks {
	enterNode?: (node: AST.AstNode) => void | boolean;
	exitNode?: (node: AST.AstNode) => void;
	// Specific node type visitors (optional)
	visitSelect?: (node: AST.SelectStmt) => void | boolean;
	visitInsert?: (node: AST.InsertStmt) => void | boolean;
	visitUpdate?: (node: AST.UpdateStmt) => void | boolean;
	visitDelete?: (node: AST.DeleteStmt) => void | boolean;
	visitValues?: (node: AST.ValuesStmt) => void | boolean;
	visitTableSource?: (node: AST.TableSource) => void | boolean;
	visitJoin?: (node: AST.JoinClause) => void | boolean;
	visitFunctionSource?: (node: AST.FunctionSource) => void | boolean;
	visitSubquerySource?: (node: AST.SubquerySource) => void | boolean;
	visitBinaryExpr?: (node: AST.BinaryExpr) => void | boolean;
	visitUnaryExpr?: (node: AST.UnaryExpr) => void | boolean;
	visitCastExpr?: (node: AST.CastExpr) => void | boolean;
	visitCollateExpr?: (node: AST.CollateExpr) => void | boolean;
	visitFunctionExpr?: (node: AST.FunctionExpr) => void | boolean;
	visitSubqueryExpr?: (node: AST.SubqueryExpr) => void | boolean;
	visitWindowFunctionExpr?: (node: AST.WindowFunctionExpr) => void | boolean;
	visitWindowDefinition?: (node: AST.WindowDefinition) => void | boolean;
	visitLiteral?: (node: AST.LiteralExpr) => void;
	visitIdentifier?: (node: AST.IdentifierExpr) => void;
	visitColumn?: (node: AST.ColumnExpr) => void;
	visitParameter?: (node: AST.ParameterExpr) => void;
}
/**
 * Performs a depth-first traversal of the AST.
 *
 * @param node The starting AST node.
 * @param callbacks An object containing visitor functions for different node types.
 */
export function traverseAst(node: AST.AstNode | undefined, callbacks: AstVisitorCallbacks): void {
	if (!node) return;

	if (callbacks.enterNode) {
		const result = callbacks.enterNode(node);
		if (result === false) return; // Stop if enterNode returns false
	}

	// Call specific visitor if defined
	const specificVisitorKey = `visit${node.type.charAt(0).toUpperCase() + node.type.slice(1)}` as keyof AstVisitorCallbacks;
	if (callbacks[specificVisitorKey]) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const specificVisitor = callbacks[specificVisitorKey] as (n: any) => void | boolean;
		const result = specificVisitor(node);
		if (result === false) return; // Stop if specific visitor returns false
	}

	// Recursively traverse children based on node type
	switch (node.type) {
		case 'select': {
			const stmt = node as AST.SelectStmt;
			stmt.withClause?.ctes.forEach(cte => traverseAst(cte.query, callbacks));
			(stmt.columns ?? []).forEach(c => {
				if (c.type === 'column') {
					traverseAst(c.expr, callbacks);
					c.inverse?.forEach(a => traverseAst(a.expr, callbacks));
				}
			});
			(stmt.from ?? []).forEach(f => traverseAst(f, callbacks));
			traverseAst(stmt.where, callbacks);
			(stmt.groupBy ?? []).forEach(g => traverseAst(g, callbacks));
			traverseAst(stmt.having, callbacks);
			(stmt.orderBy ?? []).forEach(o => traverseAst(o.expr, callbacks));
			traverseAst(stmt.limit, callbacks);
			traverseAst(stmt.offset, callbacks);
			traverseAst(stmt.compound?.select, callbacks);
			break;
		}
		case 'insert': {
			const stmt = node as AST.InsertStmt;
			stmt.withClause?.ctes.forEach(cte => traverseAst(cte.query, callbacks));
			traverseAst(stmt.table, callbacks);
			traverseAst(stmt.source, callbacks);
			break;
		}
		case 'update': {
			const stmt = node as AST.UpdateStmt;
			stmt.withClause?.ctes.forEach(cte => traverseAst(cte.query, callbacks));
			traverseAst(stmt.table, callbacks);
			// Inline subquery write target (`update (select …) as v …`): the real body
			// hangs off `targetSource`; `table` is only a synthetic alias placeholder.
			traverseAst(stmt.targetSource, callbacks);
			stmt.assignments.forEach(a => traverseAst(a.value, callbacks));
			traverseAst(stmt.where, callbacks);
			break;
		}
		case 'delete': {
			const stmt = node as AST.DeleteStmt;
			stmt.withClause?.ctes.forEach(cte => traverseAst(cte.query, callbacks));
			traverseAst(stmt.table, callbacks);
			// See `update` above — the inline subquery write target's body is on `targetSource`.
			traverseAst(stmt.targetSource, callbacks);
			traverseAst(stmt.where, callbacks);
			break;
		}
		case 'values': {
			const stmt = node as AST.ValuesStmt;
			stmt.values.forEach(row => row.forEach(v => traverseAst(v, callbacks)));
			break;
		}
		case 'table':
			// Handled by specific visitor or enterNode
			break;
		case 'join': {
			const join = node as AST.JoinClause;
			traverseAst(join.left, callbacks);
			traverseAst(join.right, callbacks);
			traverseAst(join.condition, callbacks);
			break;
		}
		case 'functionSource': {
			const funcSource = node as AST.FunctionSource;
			traverseAst(funcSource.name, callbacks);
			funcSource.args.forEach(a => traverseAst(a, callbacks));
			break;
		}
		case 'subquerySource': {
			const subqSource = node as AST.SubquerySource;
			traverseAst(subqSource.subquery, callbacks);
			break;
		}
		case 'binary': {
			const expr = node as AST.BinaryExpr;
			traverseAst(expr.left, callbacks);
			traverseAst(expr.right, callbacks);
			break;
		}
		case 'unary':
		case 'cast':
		case 'collate': {
			traverseAst((node as AST.UnaryExpr | AST.CastExpr | AST.CollateExpr).expr, callbacks);
			break;
		}
		case 'function': {
			const func = node as AST.FunctionExpr;
			func.args.forEach(a => traverseAst(a, callbacks));
			break;
		}
		case 'subquery': {
			const subq = node as AST.SubqueryExpr;
			traverseAst(subq.query, callbacks);
			break;
		}
		case 'windowFunction': {
			const winFunc = node as AST.WindowFunctionExpr;
			traverseAst(winFunc.function, callbacks);
			traverseAst(winFunc.window, callbacks);
			break;
		}
		case 'windowDefinition': {
			const winDef = node as AST.WindowDefinition;
			(winDef.partitionBy ?? []).forEach(p => traverseAst(p, callbacks));
			(winDef.orderBy ?? []).forEach(o => traverseAst(o.expr, callbacks));
			// traverseAst(winDef.frame, callbacks); // TODO: Traverse frame bounds if needed
			break;
		}
		case 'case': {
			const caseExpr = node as AST.CaseExpr;
			traverseAst(caseExpr.baseExpr, callbacks);
			caseExpr.whenThenClauses.forEach(wt => {
				traverseAst(wt.when, callbacks);
				traverseAst(wt.then, callbacks);
			});
			traverseAst(caseExpr.elseExpr, callbacks);
			break;
		}
		case 'in': {
			const inExpr = node as AST.InExpr;
			traverseAst(inExpr.expr, callbacks);
			(inExpr.values ?? []).forEach(v => traverseAst(v, callbacks));
			traverseAst(inExpr.subquery, callbacks);
			break;
		}
		case 'exists': {
			const existsExpr = node as AST.ExistsExpr;
			traverseAst(existsExpr.subquery, callbacks);
			break;
		}
		case 'between': {
			const betweenExpr = node as AST.BetweenExpr;
			traverseAst(betweenExpr.expr, callbacks);
			traverseAst(betweenExpr.lower, callbacks);
			traverseAst(betweenExpr.upper, callbacks);
			break;
		}
		// Leaf nodes (literal, identifier, column, parameter) are handled by specific visitors or enterNode
		case 'literal':
		case 'identifier':
		case 'column':
		case 'parameter':
			break;
		// DDL / Transaction statements - might need traversal depending on use case
		// Currently not traversing into them
		case 'createTable':
		case 'createIndex':
		case 'createView':
		case 'alterTable':
		case 'drop':
		case 'begin':
		case 'commit':
		case 'rollback':
		case 'savepoint':
		case 'release':
		case 'pragma':
		case 'analyze':
		case 'declareSchema':
		case 'with': // Usually handled separately before main traversal
		case 'commonTableExpr': // Usually handled separately
			break;
		// Default case for unhandled node types
		default:
			warnLog(`AST Visitor: Unhandled node type: ${node.type}`);
			break;
	}

	if (callbacks.exitNode) {
		callbacks.exitNode(node);
	}
}
