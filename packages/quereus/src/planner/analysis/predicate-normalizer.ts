import type { ScalarPlanNode } from '../nodes/plan-node.js';
import type { Scope } from '../scopes/scope.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';
import { BinaryOpNode, UnaryOpNode, LiteralNode, BetweenNode } from '../nodes/scalar.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { InNode } from '../nodes/subquery.js';
import type * as AST from '../../parser/ast.js';
import { resolveComparisonCollation, resolveInCollation } from './comparison-collation.js';

/**
 * Normalize a predicate for push-down and constraint extraction.
 *
 * Transformations (conservative, no CNF/DNF expansion):
 * - Push NOT down (De Morgan) for AND/OR and double-negation elimination
 * - Invert simple comparisons under NOT (>, >=, <, <=)
 * - Canonicalize nested AND/OR by flattening binary trees
 * - Normalize child predicates recursively
 *
 * Notes:
 * - We intentionally do NOT distribute OR over AND (to avoid blow-ups)
 * - NOT of equality becomes "!="; extractor treats it as residual (acceptable)
 * - NOT of BETWEEN toggles the node's 'not' flag
 */
export function normalizePredicate(expr: ScalarPlanNode): ScalarPlanNode {
    return normalize(expr);
}

function normalize(node: ScalarPlanNode): ScalarPlanNode {
    switch (node.nodeType) {
        case PlanNodeType.UnaryOp: {
            const u = node as UnaryOpNode;
            if (u.expression.operator === 'NOT') {
                return pushNotDown(u.operand);
            }
            // Recurse
            const normalizedOperand = normalize(u.operand);
            return normalizedOperand === u.operand
                ? u
                : new UnaryOpNode(u.scope, u.expression, normalizedOperand);
        }
        case PlanNodeType.BinaryOp: {
            const b = node as BinaryOpNode;
            const op = b.expression.operator;
            if (op === 'AND' || op === 'OR') {
                // Normalize children first
                const left = normalize(b.left);
                const right = normalize(b.right);
                // Flatten nested same-op nodes
                const parts = collectAssociative(op, [left, right]);
                if (op === 'OR') {
                    const collapsed = tryCollapseOrToIn(b.scope, parts);
                    if (collapsed) return collapsed;
                }
                return rebuildAssociative(b.scope, op, parts, b.expression);
            }
            // Other binary ops: normalize children only
            const nLeft = normalize(b.left);
            const nRight = normalize(b.right);
            if (nLeft === b.left && nRight === b.right) {
                return b;
            }
            return new BinaryOpNode(b.scope, b.expression, nLeft, nRight);
        }
        case PlanNodeType.Between: {
            // Normalize sub-expressions only
            const bt = node as BetweenNode;
            const nExpr = normalize(bt.expr);
            const nLower = normalize(bt.lower);
            const nUpper = normalize(bt.upper);
            if (nExpr === bt.expr && nLower === bt.lower && nUpper === bt.upper) {
                return bt;
            }
            return new BetweenNode(bt.scope, bt.expression, nExpr, nLower, nUpper);
        }
        default:
            return node;
    }
}

function pushNotDown(node: ScalarPlanNode): ScalarPlanNode {
    // NOT over NOT
    if (node.nodeType === PlanNodeType.UnaryOp) {
        const u = node as UnaryOpNode;
        if (u.expression.operator === 'NOT') {
            return normalize(u.operand);
        }
        // NOT over other unary ops: normalize operand, rebuild inner, re-wrap in NOT
        const nOp = normalize(u.operand);
        const inner = nOp === u.operand ? u : new UnaryOpNode(u.scope, u.expression, nOp);
        const notAst: AST.UnaryExpr = { type: 'unary', operator: 'NOT', expr: u.expression };
        return new UnaryOpNode(u.scope, notAst, inner);
    }

    if (node.nodeType === PlanNodeType.BinaryOp) {
        const b = node as BinaryOpNode;
        const op = b.expression.operator;
        // De Morgan for boolean connectives
        if (op === 'AND' || op === 'OR') {
            const negLeft = pushNotDown(b.left);
            const negRight = pushNotDown(b.right);
            const flipped = op === 'AND' ? 'OR' : 'AND';
            const expr: AST.BinaryExpr = { type: 'binary', operator: flipped, left: (b.expression.left as AST.Expression), right: (b.expression.right as AST.Expression) };
            // Rebuild and normalize/flatten
            const combined = rebuildAssociative(b.scope, flipped, [negLeft, negRight], expr);
            return combined;
        }

        // Invert simple comparisons
        const inverted = invertComparisonIfPossible(b);
        if (inverted) {
            return normalize(inverted);
        }

        // Otherwise, keep as NOT(binary) by wrapping a NOT
        const normalizedLeft = normalize(b.left);
        const normalizedRight = normalize(b.right);
        const rebuilt = (normalizedLeft === b.left && normalizedRight === b.right)
            ? b
            : new BinaryOpNode(b.scope, b.expression, normalizedLeft, normalizedRight);
        const notAst: AST.UnaryExpr = { type: 'unary', operator: 'NOT', expr: b.expression };
        return new UnaryOpNode(b.scope, notAst, rebuilt);
    }

    if (node.nodeType === PlanNodeType.Between) {
        // Toggle the NOT flag on BETWEEN
        const bt = node as BetweenNode;
        const ast: AST.BetweenExpr = { ...bt.expression, not: !bt.expression.not };
        const nExpr = normalize(bt.expr);
        const nLower = normalize(bt.lower);
        const nUpper = normalize(bt.upper);
        return new BetweenNode(bt.scope, ast, nExpr, nLower, nUpper);
    }

    // Generic fallback: NOT(expr) as unary
    const notAst: AST.UnaryExpr = { type: 'unary', operator: 'NOT', expr: node.expression };
    return new UnaryOpNode(node.scope, notAst, normalize(node));
}

function collectAssociative(op: string, parts: ScalarPlanNode[]): ScalarPlanNode[] {
    const result: ScalarPlanNode[] = [];
    for (const p of parts) {
        if (p.nodeType === PlanNodeType.BinaryOp) {
            const b = p as BinaryOpNode;
            if (b.expression.operator === op) {
                result.push(...collectAssociative(op, [b.left, b.right]));
                continue;
            }
        }
        result.push(p);
    }
    return result;
}

function rebuildAssociative(scope: Scope, op: string, parts: ScalarPlanNode[], baseExpr: AST.BinaryExpr): ScalarPlanNode {
    if (parts.length === 0) {
        // Degenerate; shouldn't happen
        return new LiteralNode(scope, { type: 'literal', value: 1 });
    }
    if (parts.length === 1) {
        return parts[0];
    }
    // Left-associative rebuild
    let acc = parts[0];
    for (let i = 1; i < parts.length; i++) {
        const right = parts[i];
        const newAst: AST.BinaryExpr = { type: 'binary', operator: op, left: acc.expression ?? baseExpr.left, right: right.expression ?? baseExpr.right };
        acc = new BinaryOpNode(scope, newAst, acc, right);
    }
    return acc;
}

function invertComparisonIfPossible(b: BinaryOpNode): ScalarPlanNode | null {
    const op = b.expression.operator;
    const flippedOp = flipComparison(op);
    if (!flippedOp) {
        return null;
    }
    const ast: AST.BinaryExpr = { type: 'binary', operator: flippedOp, left: b.expression.left, right: b.expression.right };
    return new BinaryOpNode(b.scope, ast, b.left, b.right);
}

function flipComparison(op: string): string | null {
    switch (op) {
        case '>': return '<=';
        case '>=': return '<';
        case '<': return '>=';
        case '<=': return '>';
        case '=': return '!='; // extractor will treat as residual; acceptable
        default: return null;
    }
}

// Attempt to collapse OR of equalities into an IN list when:
// - All disjuncts are of the form (col = literal)
// - The same column is used
// - Every disjunct's effective comparison collation equals the collation the
//   rewritten IN would compare under (the lattice merge of the column with
//   every collected value)
// - Literal list is small (<= 32) to avoid large INs
function tryCollapseOrToIn(_scope: Scope, disjuncts: ScalarPlanNode[]): ScalarPlanNode | null {
    const values: LiteralNode[] = [];
    const disjunctCollations: string[] = [];
    let column: ColumnReferenceNode | null = null;

    for (const d of disjuncts) {
        if (d.nodeType !== PlanNodeType.BinaryOp) return null;
        const b = d as BinaryOpNode;
        if (b.expression.operator !== '=') return null;

        // Two patterns: col = lit OR lit = col
        let col: ColumnReferenceNode | null = null;
        let lit: LiteralNode | null = null;
        if (b.left.nodeType === PlanNodeType.ColumnReference && b.right.nodeType === PlanNodeType.Literal) {
            col = b.left as ColumnReferenceNode;
            lit = b.right as LiteralNode;
        } else if (b.left.nodeType === PlanNodeType.Literal && b.right.nodeType === PlanNodeType.ColumnReference) {
            col = b.right as ColumnReferenceNode;
            lit = b.left as LiteralNode;
        } else {
            return null;
        }

        // Per-disjunct effective collation under the provenance lattice
        // (symmetric, so the col/lit spelling order is immaterial). Constant
        // folding keeps `'bob' COLLATE NOCASE` as a literal whose *type*
        // carries rank-3 NOCASE, so the shape checks above never see the
        // wrapper but the resolution still does. A conflict cannot normally
        // reach here (plan-time validation rejected it); bail conservatively.
        const disjunctResolution = resolveComparisonCollation(b.left.getType(), b.right.getType());
        if (disjunctResolution.kind !== 'resolved') return null;
        disjunctCollations.push(disjunctResolution.name);

        if (!column) {
            column = col;
        } else if (column.attributeId !== col.attributeId) {
            return null;
        }

        values.push(lit);
        if (values.length > 32) return null; // avoid creating huge IN lists
    }

    if (!column || values.length === 0) return null;

    // Collation gate (ticket `or-equality-collapse-collation-blind`): the
    // rewritten IN compares every value under ONE lattice-merged collation
    // (`emitIn`), while each written disjunct compares under its own effective
    // collation. Collapse only when every disjunct agrees with the merged IN
    // collation; both directions are unsound otherwise (a NOCASE disjunct
    // collapsed into a BINARY IN under-matches, a BINARY disjunct into a
    // NOCASE IN over-matches). Declining keeps the OR as-is — a completeness
    // loss only, like the >32-values bail. Gating BEFORE construction also
    // guarantees the InNode below validates cleanly.
    const inResolution = resolveInCollation(column.getType(), values.map(v => v.getType()));
    if (inResolution.kind !== 'resolved') return null;
    if (disjunctCollations.some(name => name !== inResolution.name)) return null;

    // Build an InNode with constant values
    const ast: AST.InExpr = {
        type: 'in',
        expr: column.expression,
        values: values.map(v => v.expression)
    };
    const inNode = new InNode(column.scope, ast, column, undefined, values);
    return inNode;
}


