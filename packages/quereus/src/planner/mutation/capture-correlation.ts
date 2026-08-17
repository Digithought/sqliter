import type * as AST from '../../parser/ast.js';
import { cloneExpr } from './scope-transform.js';

/**
 * One identifying key column of a capture correlation, with its **declared**
 * nullability. Key membership does not imply NOT NULL (docs/schema.md
 * § Primary-key nullability), and key comparison treats NULL as a value equal to
 * itself — so a capture reader correlating on a nullable key column must use the
 * NULL-safe equality {@link captureKeyEquality} emits, or a row keyed NULL is
 * silently unaddressable.
 */
export interface KeyColumnInfo {
	readonly name: string;
	/** True when the column's declared type admits NULL (`ColumnSchema.notNull === false`). */
	readonly nullable: boolean;
}

/**
 * Per-key-column equality for correlating two spellings of one key value — a
 * capture (`__vmupd_keys`) reader to its target row, and equally a decomposition
 * lens's stitch-key correlations (the get body's `anchor ⋈ member` ON condition
 * and EAV entity subquery in `schema/lens-compiler.ts`, and the write fan-out's
 * anchor EXISTS correlation in `decomposition.ts`):
 *
 * ```
 * left = right                                    -- column declared NOT NULL
 * left = right or (left is null and right is null) -- column declared nullable
 * ```
 *
 * The nullability gate exists because SQL `=` yields UNKNOWN when either operand
 * is NULL: a nullable key column needs the NULL-safe disjunction (NULL is a
 * self-equal key value), while a NOT NULL column keeps the plain `=`, which
 * stays index-friendly where a disjunction can cost the engine a seek. Sibling
 * implementation: `planner/analysis/key-filter.ts` emits the same per-column
 * shape for residual key filters (as plan nodes rather than AST).
 *
 * Operands are cloned into each emitted position, so a caller may pass the same
 * node it uses elsewhere without sharing AST subtrees.
 *
 * NOTE: the gate reads the **declared** nullability, so a database run under
 * `pragma default_column_nullability = nullable` declares every key column nullable
 * and every capture correlation takes the disjunction — including the ones a NOT NULL
 * default would have left as a seekable `=`. Correct either way, but if view writes
 * under that pragma ever show up as slow, narrow the gate to the *reachable* nullability
 * (a key column with a NOT NULL check, or one the body's predicate already excludes NULL
 * on) rather than the declared one.
 */
export function captureKeyEquality(left: AST.Expression, right: AST.Expression, nullable: boolean): AST.Expression {
	const eq: AST.Expression = { type: 'binary', operator: '=', left: cloneExpr(left), right: cloneExpr(right) };
	if (!nullable) return eq;
	const bothNull: AST.Expression = {
		type: 'binary',
		operator: 'AND',
		left: { type: 'unary', operator: 'IS NULL', expr: cloneExpr(left) } as AST.UnaryExpr,
		right: { type: 'unary', operator: 'IS NULL', expr: cloneExpr(right) } as AST.UnaryExpr,
	};
	return { type: 'binary', operator: 'OR', left: eq, right: bothNull };
}
