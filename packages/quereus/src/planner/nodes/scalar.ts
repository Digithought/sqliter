import type { ScalarType } from "../../common/datatype.js";
import { OutputValue } from "../../common/types.js";
import { PlanNode, type ScalarPlanNode, type UnaryScalarNode, type NaryScalarNode, type ZeroAryScalarNode, type BinaryScalarNode, PhysicalProperties, type ConstantNode, type TernaryScalarNode, type InjectivityResult, type MonotonicityResult, addMonotonicity, negateMonotonicity } from "./plan-node.js";
import type * as AST from "../../parser/ast.js";
import type { Scope } from "../scopes/scope.js";
import { PlanNodeType } from "./plan-node-type.js";
import { Cached } from "../../util/cached.js";
import { formatExpression, formatScalarType } from "../../util/plan-formatter.js";
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { NULL_TYPE, INTEGER_TYPE, REAL_TYPE, TEXT_TYPE, BLOB_TYPE, BOOLEAN_TYPE } from "../../types/builtin-types.js";
import { JSON_TYPE } from "../../types/json-type.js";
import { typeRegistry } from "../../types/registry.js";
import { temporalOpCaseForTypes } from "../../types/temporal-ops.js";
import { castedScalarType } from "../../types/cast-semantics.js";
import { collationConflictError, isComparisonOperator, mergePropagatedCollation, resolveComparisonCollation } from "../analysis/comparison-collation.js";

export class UnaryOpNode extends PlanNode implements UnaryScalarNode {
	readonly nodeType = PlanNodeType.UnaryOp;
	private cachedType: Cached<ScalarType>;

	constructor(
		public readonly scope: Scope,
		public readonly expression: AST.UnaryExpr,
		public readonly operand: ScalarPlanNode,
	) {
		super(scope);
		this.cachedType = new Cached(this.generateType);
	}

	generateType = (): ScalarType => {
		const operandType = this.operand.getType();

		let logicalType = operandType.logicalType;
		let nullable = operandType.nullable;

		switch (this.expression.operator) {
			case 'NOT':
				logicalType = BOOLEAN_TYPE;
				// NOT preserves nullability: NOT NULL → NULL
				break;
			case 'IS NULL':
			case 'IS NOT NULL':
			case 'IS TRUE':
			case 'IS NOT TRUE':
			case 'IS FALSE':
			case 'IS NOT FALSE':
				logicalType = BOOLEAN_TYPE;
				nullable = false; // IS [NOT] NULL/TRUE/FALSE are total — never return null
				break;
			case '-':
			case '+':
				// Numeric unary operators preserve type
				break;
			case '~':
				// Bitwise NOT - results in integer
				logicalType = INTEGER_TYPE;
				break;
		}

		return {
			typeClass: 'scalar',
			logicalType,
			nullable,
			isReadOnly: operandType.isReadOnly,
			collationName: operandType.collationName,
			collationSource: operandType.collationSource,
		};
	}

	getType(): ScalarType {
		return this.cachedType.value;
	}

	getChildren(): readonly [ScalarPlanNode] {
		return [this.operand];
	}

	getRelations(): readonly [] {
		return [];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 1) {
			quereusError(`UnaryOpNode expects 1 child, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		const [newOperand] = newChildren;

		// Type check
		if (!('expression' in newOperand)) {
			quereusError('UnaryOpNode: child must be a ScalarPlanNode', StatusCode.INTERNAL);
		}

		// Return same instance if nothing changed
		if (newOperand === this.operand) {
			return this;
		}

		// Create new instance
		return new UnaryOpNode(
			this.scope,
			this.expression,
			newOperand as ScalarPlanNode
		);
	}

	override toString(): string {
		return `${this.expression.operator} ${formatExpression(this.operand)}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			operator: this.expression.operator,
			operand: formatExpression(this.operand),
			resultType: formatScalarType(this.getType())
		};
	}

	override isInjectiveIn(inputAttrId: number): InjectivityResult {
		switch (this.expression.operator) {
			case '+':
				// Unary plus on a numeric operand is identity; pass through.
				if (this.operand.getType().logicalType.isNumeric) {
					return this.operand.isInjectiveIn(inputAttrId);
				}
				return { injective: false };
			case '-':
				// Negation on numeric operand: -x is injective iff x is.
				if (this.operand.getType().logicalType.isNumeric) {
					return this.operand.isInjectiveIn(inputAttrId);
				}
				return { injective: false };
			default:
				return { injective: false };
		}
	}

	override monotonicityIn(inputAttrId: number): MonotonicityResult {
		switch (this.expression.operator) {
			case '+': {
				if (this.operand.getType().logicalType.isNumeric) {
					return this.operand.monotonicityIn(inputAttrId);
				}
				return { monotonicity: 'unknown' };
			}
			case '-': {
				if (this.operand.getType().logicalType.isNumeric) {
					const childMon = this.operand.monotonicityIn(inputAttrId).monotonicity;
					return { monotonicity: negateMonotonicity(childMon) };
				}
				return { monotonicity: 'unknown' };
			}
			default:
				return { monotonicity: 'unknown' };
		}
	}
}

export class BinaryOpNode extends PlanNode implements BinaryScalarNode {
	readonly nodeType = PlanNodeType.BinaryOp;
	private cachedType: Cached<ScalarType>;

	constructor(
		public readonly scope: Scope,
		public readonly expression: AST.BinaryExpr,
		public readonly left: ScalarPlanNode,
		public readonly right: ScalarPlanNode,
	) {
		super(scope);

		this.cachedType = new Cached(this.generateType);
	}

	generateType = (): ScalarType => {
		const leftType = this.left.getType();
		const rightType = this.right.getType();

		let logicalType = leftType.logicalType;
		let nullable = leftType.nullable || rightType.nullable;

		switch (this.expression.operator) {
			case 'IS':
			case 'IS NOT':
				// IS/IS NOT are null-safe comparisons, never return NULL
				logicalType = BOOLEAN_TYPE;
				nullable = false;
				break;
			case 'OR':
			case 'AND':
			case '=':
			case '!=':
			case '<':
			case '<=':
			case '>':
			case '>=':
			case 'IN':
				// Comparison and logical operators return boolean
				logicalType = BOOLEAN_TYPE;
				break;
			case '+':
			case '-':
			case '*':
			case '/':
			case '%': {
				// Temporal arithmetic first: the one table both the planner and the
				// evaluator read (types/temporal-ops.ts) says what each supported
				// (operator, kind, kind) combination produces — `date - date` is a
				// TIMESPAN, `timespan / timespan` a REAL. Two numeric operands never
				// produce a case, so this is inert for ordinary arithmetic.
				const { entry: temporalCase } = temporalOpCaseForTypes(
					this.expression.operator, leftType.logicalType, rightType.logicalType);
				if (temporalCase) {
					logicalType = temporalCase.resultType;
					break;
				}
				// Arithmetic operators - implement numeric type promotion
				// Rules: INTEGER + INTEGER -> INTEGER, INTEGER + REAL -> REAL, REAL + REAL -> REAL
				if (leftType.logicalType.isNumeric && rightType.logicalType.isNumeric) {
					// Both operands are numeric
					if (leftType.logicalType.name === 'REAL' || rightType.logicalType.name === 'REAL') {
						// If either is REAL, result is REAL
						logicalType = REAL_TYPE;
					} else {
						// Both are INTEGER, result is INTEGER
						logicalType = INTEGER_TYPE;
					}
				} else {
					// Non-numeric operands - use left operand type (fallback)
					logicalType = leftType.logicalType;
				}
				break;
			}
			case '||':
				// String concatenation
				logicalType = TEXT_TYPE;
				break;
		};

		// Comparisons resolve ONE collation across both operands (symmetric
		// provenance lattice); a same-rank explicit/declared conflict is a user
		// error surfaced at plan time (builders force this lazily-cached type
		// eagerly — see building/expression.ts).
		if (isComparisonOperator(this.expression.operator)) {
			const resolution = resolveComparisonCollation(leftType, rightType);
			if (resolution.kind === 'conflict') {
				throw collationConflictError(resolution, this.expression);
			}
		}

		// Result collation propagates by provenance rank (higher-ranked
		// contribution wins; equal-rank different names propagate none), so a
		// plain operand's defaulted BINARY can no longer shadow a declared
		// collation on the other side of a concat.
		const collation = mergePropagatedCollation([leftType, rightType]);

		return {
			typeClass: 'scalar',
			logicalType,
			nullable,
			isReadOnly: leftType.isReadOnly || rightType.isReadOnly,
			collationName: collation.collationName,
			collationSource: collation.collationSource,
		};
	}

	getType(): ScalarType {
		return this.cachedType.value;
	}

	getChildren(): readonly [ScalarPlanNode, ScalarPlanNode] {
		return [this.left, this.right];
	}

	getRelations(): readonly [] {
		return [];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 2) {
			quereusError(`BinaryOpNode expects 2 children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		const [newLeft, newRight] = newChildren;

		// Type check
		if (!('expression' in newLeft) || !('expression' in newRight)) {
			quereusError('BinaryOpNode: children must be ScalarPlanNodes', StatusCode.INTERNAL);
		}

		// Return same instance if nothing changed
		if (newLeft === this.left && newRight === this.right) {
			return this;
		}

		// Create new instance
		return new BinaryOpNode(
			this.scope,
			this.expression,
			newLeft as ScalarPlanNode,
			newRight as ScalarPlanNode
		);
	}

	override toString(): string {
		return `${formatExpression(this.left)} ${this.expression.operator} ${formatExpression(this.right)}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			operator: this.expression.operator,
			left: formatExpression(this.left),
			right: formatExpression(this.right),
			resultType: formatScalarType(this.getType())
		};
	}

	private isNumericArith(): boolean {
		// Result type is numeric iff both operands are numeric (per generateType above).
		const lt = this.left.getType().logicalType;
		const rt = this.right.getType().logicalType;
		return Boolean(lt.isNumeric && rt.isNumeric);
	}

	override monotonicityIn(inputAttrId: number): MonotonicityResult {
		switch (this.expression.operator) {
			case '+': {
				if (!this.isNumericArith()) return { monotonicity: 'unknown' };
				const lm = this.left.monotonicityIn(inputAttrId).monotonicity;
				const rm = this.right.monotonicityIn(inputAttrId).monotonicity;
				return { monotonicity: addMonotonicity(lm, rm) };
			}
			case '-': {
				if (!this.isNumericArith()) return { monotonicity: 'unknown' };
				const lm = this.left.monotonicityIn(inputAttrId).monotonicity;
				const rm = this.right.monotonicityIn(inputAttrId).monotonicity;
				// a - b ≡ a + (-b)
				return { monotonicity: addMonotonicity(lm, negateMonotonicity(rm)) };
			}
			default:
				return { monotonicity: 'unknown' };
		}
	}

	override isInjectiveIn(inputAttrId: number): InjectivityResult {
		switch (this.expression.operator) {
			case '+':
			case '-': {
				if (!this.isNumericArith()) return { injective: false };
				const lm = this.left.monotonicityIn(inputAttrId).monotonicity;
				const rm = this.right.monotonicityIn(inputAttrId).monotonicity;
				// One side flat in attrId → injectivity passes through from the other side.
				if (lm === 'constant') {
					const inj = this.right.isInjectiveIn(inputAttrId);
					// `a - b`: if left is constant, result is `c - b`, still injective when b is.
					// `a + b`: same.
					return inj;
				}
				if (rm === 'constant') {
					return this.left.isInjectiveIn(inputAttrId);
				}
				// Both depend on attrId. Strict monotonicity (same direction for `+`,
				// opposite directions for `-`) implies injectivity.
				const combined = this.expression.operator === '+'
					? addMonotonicity(lm, rm)
					: addMonotonicity(lm, negateMonotonicity(rm));
				if (combined === 'increasing' || combined === 'decreasing') {
					return { injective: true };
				}
				return { injective: false };
			}
			default:
				return { injective: false };
		}
	}
}

export class LiteralNode extends PlanNode implements ZeroAryScalarNode, ConstantNode {
	readonly nodeType = PlanNodeType.Literal;
	/**
	 * When constant folding replaces an expression with a literal, we still need to
	 * preserve the *type metadata* (affinity, collation, nullability, etc.).
	 *
	 * The optional `explicitType` allows the caller to override the
	 * automatically-derived type so that information (e.g. COLLATE NOCASE)
	 * survives the folding pass.
	 */
	constructor(
		public readonly scope: Scope,
		public readonly expression: AST.LiteralExpr,
		private readonly explicitType?: ScalarType,
	) {
		super(scope, 0.001); // Minimal cost
	}

	getType(): ScalarType {
		// If a caller supplied an explicit type (to preserve metadata such as
		// collation) honour it verbatim.
		if (this.explicitType) {
			return this.explicitType;
		}
		const value = this.expression.value;
		if (value === null) {
			return {
				typeClass: 'scalar',
				logicalType: NULL_TYPE,
				nullable: true,
				isReadOnly: true,
			};
		}
		if (typeof value === 'number') {
			return {
				typeClass: 'scalar',
				logicalType: REAL_TYPE,
				nullable: false,
				isReadOnly: true,
			};
		}
		if (typeof value === 'bigint') {
			return {
				typeClass: 'scalar',
				logicalType: INTEGER_TYPE,
				nullable: false,
				isReadOnly: true,
			};
		}
		if (typeof value === 'string') {
			return {
				typeClass: 'scalar',
				logicalType: TEXT_TYPE,
				nullable: false,
				isReadOnly: true,
			};
		}
		if (typeof value === 'boolean') {
			return {
				typeClass: 'scalar',
				logicalType: BOOLEAN_TYPE,
				nullable: false,
				isReadOnly: true,
			};
		}
		if (value instanceof Uint8Array) {
			return {
				typeClass: 'scalar',
				logicalType: BLOB_TYPE,
				nullable: false,
				isReadOnly: true,
			};
		}
		// Native object/array: the only logical type whose physical representation is
		// PhysicalType.OBJECT is JSON, so an untyped object-valued literal is a JSON
		// document. Reached when a rule rebuilds a literal from a plain constant value
		// (e.g. an index seek key) without threading the source ScalarType through.
		if (typeof value === 'object') {
			return {
				typeClass: 'scalar',
				logicalType: JSON_TYPE,
				nullable: false,
				isReadOnly: true,
			};
		}
		quereusError(`Unknown literal type ${typeof value}`, StatusCode.INTERNAL);
	}

	getValue(): OutputValue {
		return this.expression.value;
	}

	getChildren(): readonly [] {
		return [];
	}

	getRelations(): readonly [] {
		return [];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 0) {
			quereusError(`LiteralNode expects 0 children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}
		return this; // No children, so no change
	}

	override toString(): string {
		const value = this.expression.value;
		if (value === null) return 'NULL';
		if (typeof value === 'string') return `'${value}'`;
		if (value instanceof Uint8Array) return `X'${Array.from(value, b => b.toString(16).padStart(2, '0')).join('')}'`;
		return String(value);
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			value: this.expression.value,
			resultType: formatScalarType(this.getType())
		};
	}

	override computePhysical(): Partial<PhysicalProperties> {
		return {
			constant: true,
		};
	}

	override monotonicityIn(_inputAttrId: number): MonotonicityResult {
		return { monotonicity: 'constant' };
	}
}

export class CaseExprNode extends PlanNode implements NaryScalarNode {
	readonly nodeType = PlanNodeType.CaseExpr;
	private cachedType: Cached<ScalarType>;

	constructor(
		public readonly scope: Scope,
		public readonly expression: AST.CaseExpr,
		public readonly baseExpr: ScalarPlanNode | undefined,
		public readonly whenThenClauses: { when: ScalarPlanNode; then: ScalarPlanNode }[],
		public readonly elseExpr: ScalarPlanNode | undefined,
	) {
		super(scope, 0.02 * whenThenClauses.length);
		this.cachedType = new Cached(this.generateType);
	}

	getType(): ScalarType {
		return this.cachedType.value;
	}

	generateType = (): ScalarType => {
		// Determine the result type based on all THEN expressions and the ELSE expression
		const resultExpressions = [
			...this.whenThenClauses.map(clause => clause.then),
			...(this.elseExpr ? [this.elseExpr] : [])
		];

		if (resultExpressions.length === 0) {
			// No THEN clauses and no ELSE - should not happen in valid SQL
			return {
				typeClass: 'scalar',
				logicalType: NULL_TYPE,
				nullable: true,
				isReadOnly: true,
			};
		}

		// Use the first result expression as the base type
		const firstType = resultExpressions[0].getType();
		let logicalType = firstType.logicalType;
		let nullable = firstType.nullable;
		let isReadOnly = firstType.isReadOnly;

		// Check all other result expressions for type compatibility
		for (let i = 1; i < resultExpressions.length; i++) {
			const exprType = resultExpressions[i].getType();

			// If any result can be null, the whole CASE can be null
			if (exprType.nullable) {
				nullable = true;
			}

			// If any result is read-only, consider the whole CASE read-only
			if (exprType.isReadOnly) {
				isReadOnly = true;
			}

			// TODO: Implement proper type coercion rules for SQL
			// For now, if types differ, default to TEXT
			if (exprType.logicalType !== logicalType) {
				logicalType = TEXT_TYPE;
			}
		}

		// Branch collations merge by provenance rank (order-independent);
		// equal-rank disagreement propagates no collation rather than letting
		// branch order pick a winner.
		const collation = mergePropagatedCollation(resultExpressions.map(e => e.getType()));

		// If there's no ELSE clause, the result can be NULL
		if (!this.elseExpr) {
			nullable = true;
		}

		return {
			typeClass: 'scalar',
			logicalType,
			nullable,
			isReadOnly,
			collationName: collation.collationName,
			collationSource: collation.collationSource,
		};
	}

	get operands(): readonly ScalarPlanNode[] {
		const allOperands: ScalarPlanNode[] = [];

		if (this.baseExpr) {
			allOperands.push(this.baseExpr);
		}

		for (const clause of this.whenThenClauses) {
			allOperands.push(clause.when, clause.then);
		}

		if (this.elseExpr) {
			allOperands.push(this.elseExpr);
		}

		return allOperands;
	}

	getChildren(): readonly ScalarPlanNode[] {
		return this.operands;
	}

	getRelations(): readonly [] {
		return [];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		const expectedLength = this.operands.length;
		if (newChildren.length !== expectedLength) {
			quereusError(`CaseExprNode expects ${expectedLength} children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		// Type check
		for (const child of newChildren) {
			if (!('expression' in child)) {
				quereusError('CaseExprNode: all children must be ScalarPlanNodes', StatusCode.INTERNAL);
			}
		}

		// Check if anything changed
		const childrenChanged = newChildren.some((child, i) => child !== this.operands[i]);
		if (!childrenChanged) {
			return this;
		}

		// Rebuild the complex structure
		let childIndex = 0;
		let newBaseExpr: ScalarPlanNode | undefined = undefined;

		if (this.baseExpr) {
			newBaseExpr = newChildren[childIndex] as ScalarPlanNode;
			childIndex++;
		}

		const newWhenThenClauses: { when: ScalarPlanNode; then: ScalarPlanNode }[] = [];
		for (let i = 0; i < this.whenThenClauses.length; i++) {
			const when = newChildren[childIndex] as ScalarPlanNode;
			const then = newChildren[childIndex + 1] as ScalarPlanNode;
			newWhenThenClauses.push({ when, then });
			childIndex += 2;
		}

		let newElseExpr: ScalarPlanNode | undefined = undefined;
		if (this.elseExpr) {
			newElseExpr = newChildren[childIndex] as ScalarPlanNode;
		}

		// Create new instance
		return new CaseExprNode(
			this.scope,
			this.expression,
			newBaseExpr,
			newWhenThenClauses,
			newElseExpr
		);
	}

	override toString(): string {
		const baseStr = this.baseExpr ? ` ${formatExpression(this.baseExpr)}` : '';
		const whenThenStr = this.whenThenClauses
			.map(clause => ` WHEN ${formatExpression(clause.when)} THEN ${formatExpression(clause.then)}`)
			.join('');
		const elseStr = this.elseExpr ? ` ELSE ${formatExpression(this.elseExpr)}` : '';
		return `CASE${baseStr}${whenThenStr}${elseStr} END`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		const props: Record<string, unknown> = {
			resultType: formatScalarType(this.getType()),
			whenThenClauses: this.whenThenClauses.map(clause => ({
				when: formatExpression(clause.when),
				then: formatExpression(clause.then)
			}))
		};

		if (this.baseExpr) {
			props.baseExpression = formatExpression(this.baseExpr);
		}

		if (this.elseExpr) {
			props.elseExpression = formatExpression(this.elseExpr);
		}

		return props;
	}
}

export class CastNode extends PlanNode implements UnaryScalarNode {
	readonly nodeType = PlanNodeType.Cast;
	private cachedType: Cached<ScalarType>;

	constructor(
		public readonly scope: Scope,
		public readonly expression: AST.CastExpr,
		public readonly operand: ScalarPlanNode,
	) {
		super(scope, 0.02); // Slightly higher cost for type conversion
		this.cachedType = new Cached(this.generateType);
	}

	getType(): ScalarType {
		return this.cachedType.value;
	}

	generateType = (): ScalarType => {
		// Resolve through inferType, not getTypeOrDefault: this is the single resolution
		// of the target name — `runtime/emit/cast.ts` reads it back off this node — and
		// the two lookups disagree for any name that misses the registry but matches an
		// affinity rule (`cast(5 as nvarchar)` produces TEXT, not BLOB).
		const logicalType = typeRegistry.inferType(this.expression.targetType);

		// Nullability / collation rules live with the cast semantics, shared with the
		// emit-time comparison-key path (`runtime/emit/operand-comparator.ts`).
		return castedScalarType(this.operand.getType(), logicalType);
	}

	getChildren(): readonly [ScalarPlanNode] {
		return [this.operand];
	}

	getRelations(): readonly [] {
		return [];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 1) {
			quereusError(`CastNode expects 1 child, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		const [newOperand] = newChildren;

		// Type check
		if (!('expression' in newOperand)) {
			quereusError('CastNode: child must be a ScalarPlanNode', StatusCode.INTERNAL);
		}

		// Return same instance if nothing changed
		if (newOperand === this.operand) {
			return this;
		}

		// Create new instance
		return new CastNode(
			this.scope,
			this.expression,
			newOperand as ScalarPlanNode
		);
	}

	override toString(): string {
		return `CAST(${formatExpression(this.operand)} AS ${this.expression.targetType})`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			operand: formatExpression(this.operand),
			targetType: this.expression.targetType,
			resultType: formatScalarType(this.getType())
		};
	}

	override isInjectiveIn(inputAttrId: number): InjectivityResult {
		// Conservative starter rule: only treat the cast as a no-op when the
		// target logical type exactly matches the operand's. Wider-integer casts
		// would also be safe but require a "wider with no value collisions"
		// check from the type system — deferred.
		const operandType = this.operand.getType().logicalType;
		const targetType = this.getType().logicalType;
		if (operandType === targetType) {
			return this.operand.isInjectiveIn(inputAttrId);
		}
		return { injective: false };
	}
}

/**
 * `<operand> COLLATE <name>` — identity on values, overrides the collation the
 * surrounding comparison/ordering resolves.
 *
 * **Deliberately NOT injective** (`isInjectiveIn` stays the conservative
 * `PlanNode` default of `false`) even though COLLATE is value-injective: a
 * passthrough would let `deriveProjectionColumnMap` map a key minted under the
 * source column's collation onto a column *published* with this node's
 * collation. Key consumers interpret a key column under its **output**
 * collation (the DISTINCT emitter resolves each attribute's collation; an MV
 * backing PK uses the output collation), so a BINARY-enforced key surfacing on
 * a NOCASE-published column would over-claim distinctness ('Bob' vs 'bob' are
 * one NOCASE key value but two BINARY-distinct rows). Any future enablement
 * needs a collation-strength gate at the key-propagation site: the output
 * collation must be at least as fine as the source key's enforcement
 * collation. Pinned by "CollateNode is not injective" tests (ticket
 * `collation-blind-equality-fact-extraction`).
 */
export class CollateNode extends PlanNode implements UnaryScalarNode {
	readonly nodeType = PlanNodeType.Collate;
	private cachedType: Cached<ScalarType>;

	constructor(
		public readonly scope: Scope,
		public readonly expression: AST.CollateExpr,
		public readonly operand: ScalarPlanNode,
	) {
		super(scope, 0.001); // Minimal cost for COLLATE
		this.cachedType = new Cached(this.generateType);
	}

	getType(): ScalarType {
		return this.cachedType.value;
	}

	generateType = (): ScalarType => {
		const operandType = this.operand.getType();

		return {
			...operandType,
			collationName: this.expression.collation.toUpperCase(),
			// A COLLATE wrapper is the strongest provenance — rank 3 in the
			// comparison-resolution lattice (even `collate binary` is a demand).
			collationSource: 'explicit',
		};
	}

	getChildren(): readonly [ScalarPlanNode] {
		return [this.operand];
	}

	getRelations(): readonly [] {
		return [];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 1) {
			quereusError(`CollateNode expects 1 child, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		const [newOperand] = newChildren;

		// Type check
		if (!('expression' in newOperand)) {
			quereusError('CollateNode: child must be a ScalarPlanNode', StatusCode.INTERNAL);
		}

		// Return same instance if nothing changed
		if (newOperand === this.operand) {
			return this;
		}

		// Create new instance
		return new CollateNode(
			this.scope,
			this.expression,
			newOperand as ScalarPlanNode
		);
	}

	override toString(): string {
		return `${formatExpression(this.operand)} COLLATE ${this.expression.collation}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			operand: formatExpression(this.operand),
			collation: this.expression.collation,
			resultType: formatScalarType(this.getType())
		};
	}
}

export class BetweenNode extends PlanNode implements TernaryScalarNode {
	readonly nodeType = PlanNodeType.Between;
	private cachedType: Cached<ScalarType>;

	constructor(
		public readonly scope: Scope,
		public readonly expression: AST.BetweenExpr,
		public readonly expr: ScalarPlanNode,
		public readonly lower: ScalarPlanNode,
		public readonly upper: ScalarPlanNode,
	) {
		super(scope, 0.03); // Cost for three comparisons
		this.cachedType = new Cached(this.generateType);
	}

	generateType = (): ScalarType => {
		// BETWEEN desugars to `expr >= lower AND expr <= upper`: each bound is
		// an independent comparison, validated per-bound against the tested
		// expression (two differently-collated bounds are NOT a conflict with
		// each other). Eagerly forced at build time — see building/expression.ts.
		const exprType = this.expr.getType();
		for (const bound of [this.lower, this.upper]) {
			const resolution = resolveComparisonCollation(exprType, bound.getType());
			if (resolution.kind === 'conflict') {
				throw collationConflictError(resolution, this.expression);
			}
		}
		// If any operand is nullable, the result can be NULL
		return {
			typeClass: 'scalar',
			logicalType: BOOLEAN_TYPE,
			nullable: exprType.nullable || this.lower.getType().nullable || this.upper.getType().nullable,
			isReadOnly: true,
		};
	}

	getType(): ScalarType {
		return this.cachedType.value;
	}

	getChildren(): readonly [ScalarPlanNode, ScalarPlanNode, ScalarPlanNode] {
		return [this.expr, this.lower, this.upper];
	}

	getRelations(): readonly [] {
		return [];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 3) {
			quereusError(`BetweenNode expects 3 children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		const [newExpr, newLower, newUpper] = newChildren;

		// Type check
		for (const child of newChildren) {
			if (!('expression' in child)) {
				quereusError('BetweenNode: all children must be ScalarPlanNodes', StatusCode.INTERNAL);
			}
		}

		// Return same instance if nothing changed
		if (newExpr === this.expr && newLower === this.lower && newUpper === this.upper) {
			return this;
		}

		// Create new instance
		return new BetweenNode(
			this.scope,
			this.expression,
			newExpr as ScalarPlanNode,
			newLower as ScalarPlanNode,
			newUpper as ScalarPlanNode
		);
	}

	override toString(): string {
		const notPrefix = this.expression.not ? 'NOT ' : '';
		return `${formatExpression(this.expr)} ${notPrefix}BETWEEN ${formatExpression(this.lower)} AND ${formatExpression(this.upper)}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			expr: formatExpression(this.expr),
			lower: formatExpression(this.lower),
			upper: formatExpression(this.upper),
			not: this.expression.not ?? false,
			resultType: formatScalarType(this.getType())
		};
	}
}
