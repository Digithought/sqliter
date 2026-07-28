import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { LiteralNode, BinaryOpNode, UnaryOpNode, CaseExprNode, CastNode, CollateNode, BetweenNode } from '../nodes/scalar.js';
import { insertCrossTypeCoercion, coerceObjectPhysicalSet } from './coercion.js';
import { ScalarSubqueryNode, InNode, ExistsNode } from '../nodes/subquery.js';
import { WindowFunctionCallNode } from '../nodes/window-function.js';
import type { ScalarPlanNode, RelationalPlanNode } from '../nodes/plan-node.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { RelationType } from '../../common/datatype.js';
import { resolveColumn, resolveParameter } from '../resolve.js';
import { Ambiguous } from '../scopes/scope.js';
import { buildSelectStmt, buildValuesStmt } from './select.js';
import { buildInsertStmt } from './insert.js';
import { buildUpdateStmt } from './update.js';
import { buildDeleteStmt } from './delete.js';
import { resolveWindowFunction } from '../../schema/window-function.js';
import { buildFunctionCall } from './function-call.js';
import { createLogger } from '../../common/logger.js';

/**
 * Plans a `QueryExpr` in scalar / IN / EXISTS expression position.
 *
 * SELECT and VALUES legs lower to their normal relational builders. DML
 * legs (INSERT/UPDATE/DELETE with RETURNING — the parser requires RETURNING
 * in this position) build through the standard DML builders and yield a
 * `ReturningNode`. The runtime emitters for scalar / IN / EXISTS detect a
 * side-effecting inner via `subtreeHasSideEffects` and apply full-drain +
 * run-once semantics (see `docs/runtime.md`).
 */
function buildExpressionPositionQueryExpr(
	ctx: PlanningContext,
	query: AST.QueryExpr,
	preserveInputColumns: boolean,
	_siteLabel: 'scalar subquery' | 'IN subquery' | 'EXISTS subquery',
): RelationalPlanNode {
	switch (query.type) {
		case 'select':
			return buildSelectStmt(ctx, query, ctx.cteNodes, preserveInputColumns) as RelationalPlanNode;
		case 'values':
			return buildValuesStmt(ctx, query);
		case 'insert':
			return buildInsertStmt(ctx, query) as RelationalPlanNode;
		case 'update':
			return buildUpdateStmt(ctx, query) as RelationalPlanNode;
		case 'delete':
			return buildDeleteStmt(ctx, query) as RelationalPlanNode;
	}
}

const logger = createLogger('planner:expression');

/** Comparison operators that should trigger cross-category coercion insertion */
const COMPARISON_OPS = new Set(['=', '==', '!=', '<>', '<', '<=', '>', '>=']);

/**
 * Builds an expression plan node from an AST expression.
 */
export function buildExpression(ctx: PlanningContext, expr: AST.Expression, allowAggregates: boolean = false): ScalarPlanNode {
  switch (expr.type) {
    case 'literal':
      return new LiteralNode(ctx.scope, expr);

    case 'column': {
      const colResolution = resolveColumn(ctx.scope, expr, ctx.db.schemaManager.getCurrentSchemaName());

      if (colResolution === Ambiguous) {
        throw new QuereusError(`ambiguous column name: ${expr.name}`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
      }
      if (!colResolution) {
        throw new QuereusError(`Column not found: ${expr.name}`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
      }
      return colResolution as ScalarPlanNode;
		}

		case 'parameter': {
      const paramResolution = resolveParameter(ctx.scope, expr);
      if (paramResolution === Ambiguous) {
        throw new QuereusError(`ambiguous parameter: ${expr.name ?? expr.index}`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
      }
      if (!paramResolution) {
        throw new QuereusError(`Parameter not found: ${expr.name ?? expr.index}`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
      }
      return paramResolution as ScalarPlanNode;
		}

		case 'unary': {
      // Optimization: fold unary minus over numeric literals into negative literals
      if (expr.operator === '-' && expr.expr.type === 'literal') {
        const literalExpr = expr.expr as AST.LiteralExpr;
        if (typeof literalExpr.value === 'number' || typeof literalExpr.value === 'bigint') {
          // Create a new literal expression with the negated value
          const negatedLiteral: AST.LiteralExpr = {
            type: 'literal',
            value: typeof literalExpr.value === 'bigint' ? -literalExpr.value : -literalExpr.value,
            lexeme: literalExpr.lexeme ? `-${literalExpr.lexeme}` : undefined,
            loc: expr.loc // Use the location of the entire unary expression
          };
          return new LiteralNode(ctx.scope, negatedLiteral);
        }
      }

      const operand = buildExpression(ctx, expr.expr, allowAggregates);
      return new UnaryOpNode(ctx.scope, expr, operand);
		}

		case 'binary': {
      let left = buildExpression(ctx, expr.left, allowAggregates);
      let right = buildExpression(ctx, expr.right, allowAggregates);
      // For comparison operators, insert explicit casts when one side is
      // numeric and the other textual so the runtime can use the fast path.
      if (COMPARISON_OPS.has(expr.operator)) {
        [left, right] = insertCrossTypeCoercion(ctx.scope, left, right);
      }
      const binaryNode = new BinaryOpNode(ctx.scope, expr, left, right);
      // Comparisons validate their collation lattice in generateType, which is
      // lazily cached — force it so a conflict errors at prepare time.
      if (COMPARISON_OPS.has(expr.operator)) {
        binaryNode.getType();
      }
      return binaryNode;
		}

    case 'case': {
      // Build base expression if present
      let baseExpr = expr.baseExpr ? buildExpression(ctx, expr.baseExpr, allowAggregates) : undefined;

      // Build WHEN/THEN clauses
      const whenThenClauses = expr.whenThenClauses.map(clause => ({
        when: buildExpression(ctx, clause.when, allowAggregates),
        then: buildExpression(ctx, clause.then, allowAggregates)
      }));

      // A simple CASE compares its base against every WHEN, so it needs the same
      // object-physical reconciliation an IN list gets — otherwise
      // `case json_col when '{"a":1}'` disagrees with `json_col = '{"a":1}'`.
      if (baseExpr) {
        const [coercedBase, coercedWhens] = coerceObjectPhysicalSet(
          ctx.scope, baseExpr, whenThenClauses.map(c => c.when));
        baseExpr = coercedBase;
        coercedWhens.forEach((when, i) => { whenThenClauses[i].when = when; });
      }

      // Build ELSE expression if present
      const elseExpr = expr.elseExpr ? buildExpression(ctx, expr.elseExpr, allowAggregates) : undefined;

      return new CaseExprNode(ctx.scope, expr, baseExpr, whenThenClauses, elseExpr);
		}

    case 'cast': {
      const castOperand = buildExpression(ctx, expr.expr, allowAggregates);
      return new CastNode(ctx.scope, expr, castOperand);
    }

    case 'collate': {
      const collateOperand = buildExpression(ctx, expr.expr, allowAggregates);
      return new CollateNode(ctx.scope, expr, collateOperand);
    }

		case 'function': return buildFunctionCall(ctx, expr, allowAggregates);

    case 'subquery': {
       // For scalar subqueries, create a context that allows correlation
       // The buildSelectStmt will create the proper scope chain with subquery tables taking precedence
       // CRITICAL: Share the cteReferenceCache to ensure consistent attribute IDs across contexts
       logger(`Building scalar subquery - ctx.cteReferenceCache size: ${ctx.cteReferenceCache?.size ?? 'undefined'}`);
       const subqueryContext = {
         ...ctx,
         cteReferenceCache: ctx.cteReferenceCache || new Map()
       };
       // Preserve input columns in scalar subqueries to ensure correlated predicates
       // have access to all underlying attributes.
       const subqueryPlan = buildExpressionPositionQueryExpr(subqueryContext, expr.query, true, 'scalar subquery');
       logger(`Building scalar subquery with preserveInputColumns=true`);
       // Validate that scalar subquery returns exactly one column
       const scalarSubqueryType = subqueryPlan.getType();
       if (scalarSubqueryType.typeClass === 'relation' && (scalarSubqueryType as RelationType).columns.length !== 1) {
         throw new QuereusError('Scalar subquery must return exactly one column', StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
       }
       return new ScalarSubqueryNode(ctx.scope, expr, subqueryPlan);
		}

		case 'windowFunction': {
       // Window functions are handled by creating a WindowFunctionCallNode
       // First validate that this is a registered window function
       const windowSchema = resolveWindowFunction(expr.function.name);
       if (!windowSchema) {
         throw new QuereusError(`Unknown window function: ${expr.function.name}`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
       }

       // Validate argument count (special case for COUNT(*))
       const isCountStar = expr.function.name.toLowerCase() === 'count' && expr.function.args.length === 0;
       if (windowSchema.argCount !== 'variadic' && expr.function.args.length !== windowSchema.argCount && !isCountStar) {
         throw new QuereusError(`Window function ${expr.function.name} expects ${windowSchema.argCount} arguments, got ${expr.function.args.length}`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
       }

       // Validate ORDER BY requirement
       if (windowSchema.requiresOrderBy && (!expr.window?.orderBy || expr.window.orderBy.length === 0)) {
         throw new QuereusError(`Window function ${expr.function.name} requires ORDER BY clause`, StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
       }

       // Build the argument expressions to derive their logical types. The
       // authoritative argument plan nodes are (re)built in select-window.ts for
       // the WindowNode; these exist only so this node's getType() can consult
       // inferReturnType (e.g. min(text_col) over (...) must type as TEXT so a
       // surrounding `|| 'x'` types correctly).
       const windowArgTypes = expr.function.args.map(arg =>
         buildExpression(ctx, arg, false).getType().logicalType
       );

       return new WindowFunctionCallNode(
         ctx.scope,
         expr,
         expr.function.name,
         expr.function.distinct ?? false,
         undefined,
         windowArgTypes
       );
		}

		case 'in': {
       // Build the left expression
       const leftExpr = buildExpression(ctx, expr.expr, allowAggregates);

       if (expr.subquery) {
         // IN subquery: expr IN (<QueryExpr>)
         const inSubqueryContext = {
           ...ctx,
           cteReferenceCache: ctx.cteReferenceCache || new Map()
         };
         const inSubqueryPlan = buildExpressionPositionQueryExpr(inSubqueryContext, expr.subquery, true, 'IN subquery');
         // Validate that subquery returns exactly one column
         const subqueryType = inSubqueryPlan.getType();
         if (subqueryType.typeClass === 'relation' && (subqueryType as RelationType).columns.length !== 1) {
           throw new QuereusError('IN subquery must return exactly one column', StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
         }
                   const inSubqueryNode = new InNode(ctx.scope, expr, leftExpr, inSubqueryPlan);
                   // Force the lazily-cached generateType so a collation-lattice
                   // conflict errors at prepare time, not first emit.
                   inSubqueryNode.getType();
                   return inSubqueryNode;
               } else if (expr.values) {
          // IN value list: expr IN (value1, value2, ...)
          const rawValueExprs = expr.values.map(val => buildExpression(ctx, val, allowAggregates));
          const [inLeft, valueExprs] = coerceObjectPhysicalSet(ctx.scope, leftExpr, rawValueExprs);
          const inListNode = new InNode(ctx.scope, expr, inLeft, undefined, valueExprs);
          // Same eager collation-lattice validation as the subquery form.
          inListNode.getType();
          return inListNode;
       } else {
         throw new QuereusError('IN expression must have either values or subquery', StatusCode.ERROR, undefined, expr.loc?.start.line, expr.loc?.start.column);
       }
		}

    case 'exists': {
       // Build the EXISTS subquery
       const existsSubqueryContext = {
         ...ctx,
         cteReferenceCache: ctx.cteReferenceCache || new Map()
       };
       const existsSubqueryPlan = buildExpressionPositionQueryExpr(existsSubqueryContext, expr.subquery, true, 'EXISTS subquery');
       return new ExistsNode(ctx.scope, expr, existsSubqueryPlan);
		}

    case 'between': {
       // Build the BETWEEN expression: expr BETWEEN lower AND upper
       let exprNode = buildExpression(ctx, expr.expr, allowAggregates);
       let lowerNode = buildExpression(ctx, expr.lower, allowAggregates);
       let upperNode = buildExpression(ctx, expr.upper, allowAggregates);
       // Insert explicit casts for cross-category operands (same logic as comparisons)
       [exprNode, lowerNode] = insertCrossTypeCoercion(ctx.scope, exprNode, lowerNode);
       [exprNode, upperNode] = insertCrossTypeCoercion(ctx.scope, exprNode, upperNode);
       const betweenNode = new BetweenNode(ctx.scope, expr, exprNode, lowerNode, upperNode);
       // Force the lazily-cached generateType so a per-bound collation-lattice
       // conflict errors at prepare time.
       betweenNode.getType();
       return betweenNode;
		}

		default:
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      throw new QuereusError(`Expression type '${(expr as any).type}' not yet supported in buildExpression.`, StatusCode.UNSUPPORTED, undefined, expr.loc?.start.line, expr.loc?.start.column);
  }
}
