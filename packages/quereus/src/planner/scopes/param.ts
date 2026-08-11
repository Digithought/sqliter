import type * as AST from '../../parser/ast.js';
import { ParameterReferenceNode } from '../nodes/reference.js'; // Corrected import
import { BaseScope } from './base.js';
import { Ambiguous, type Scope } from './scope.js';
import type { ScalarType } from '../../common/datatype.js';
import type { PlanNode } from '../nodes/plan-node.js';
import { TEXT_TYPE } from '../../types/builtin-types.js';
import { normalizeParamKey } from '../../core/param.js';

// Default type for parameters when not otherwise specified.
const DEFAULT_PARAMETER_TYPE: ScalarType = {
	typeClass: 'scalar',
	logicalType: TEXT_TYPE,
	nullable: true,
};

/**
 * A scope that resolves query parameters (e.g., :name, :1, ?).
 * It makes these parameters available via an accessor.
 */
export class ParameterScope extends BaseScope {
	private _nextAnonymousIndex: number = 1;
	private readonly _parameters: Map<string | number, ParameterReferenceNode> = new Map();
	private readonly _parameterTypes: ReadonlyMap<string | number, ScalarType>;

	constructor(
		public readonly parentScope: Scope,
		parameterTypes?: ReadonlyMap<string | number, ScalarType>
	) {
		super();
		this._parameterTypes = parameterTypes || new Map();
	}

	resolveSymbol(symbolKey: string, expression: AST.Expression): PlanNode | typeof Ambiguous | undefined {
		let identifier: string | number;
		let parameterNode: ParameterReferenceNode | undefined;

		// The expression should be an AST.ParameterExpr when symbolKey indicates a parameter
		const parameterExpression = expression as AST.ParameterExpr;
		let resolvedType = DEFAULT_PARAMETER_TYPE;

		if (symbolKey === '?') {
			// Positional '?' parameters bind in SOURCE-TEXT order. The parser stamps each '?'
			// with a left-to-right, 1-based `index` (parser.ts: this.parameterPosition++), and the
			// rest of the pipeline keys positional args by array position (database.ts/statement.ts
			// boundArgs[index+1], core/param.ts type hints). So we MUST honour the parser's text-order
			// index here rather than re-deriving order from when the planner happens to resolve nodes
			// (FROM/WHERE resolve before SELECT-projection), which would mis-order a projection '?'
			// relative to later WHERE/FROM '?'s and also mis-assign type hints.
			//
			// Fall back to the running counter only for synthetic parameter nodes that lack an index.
			const currentAnonymousId = parameterExpression.index ?? this._nextAnonymousIndex;

			// Check if this specific anonymous parameter (by its text-order index) has a declared type
			if (this._parameterTypes.has(currentAnonymousId)) {
				resolvedType = this._parameterTypes.get(currentAnonymousId)!;
			}
			identifier = currentAnonymousId;
			parameterNode = new ParameterReferenceNode(this, parameterExpression, identifier, resolvedType);
			this._parameters.set(identifier, parameterNode); // Cache it by its text-order numeric ID
			this._nextAnonymousIndex++; // Advance the fallback counter for any index-less synthetic '?'
		} else if (symbolKey.startsWith(':')) {
			const nameOrIndex = symbolKey.substring(1);
			identifier = normalizeParamKey(nameOrIndex);

			if (this._parameters.has(identifier)) {
				parameterNode = this._parameters.get(identifier)!;
				// If already exists, its type was set at creation
			} else {
				if (this._parameterTypes.has(identifier)) {
					resolvedType = this._parameterTypes.get(identifier)!;
				}
				parameterNode = new ParameterReferenceNode(this, parameterExpression, identifier, resolvedType);
				this._parameters.set(identifier, parameterNode);
			}
		} else {
			// Not a parameter symbol, delegate to parent scope
			return this.parentScope.resolveSymbol(symbolKey, expression);
		}

		return parameterNode;
	}

	/**
	 * Returns all parameters resolved by this scope.
	 */
	getParameters(): ReadonlyMap<string | number, ParameterReferenceNode> {
		return this._parameters;
	}

}
