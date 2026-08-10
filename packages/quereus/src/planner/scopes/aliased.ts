import type { PlanNode } from "../nodes/plan-node.js";
import type { Scope } from "./scope.js";
import { Ambiguous } from "./scope.js";
import * as AST from "../../parser/ast.js";
import { BaseScope } from "./base.js";

/**
 * A Scope that aliases a parent scope.
 *
 * @param parent The parent scope, assumed to already be populated with symbols..
 */
export class AliasedScope extends BaseScope {
	private readonly _parentName: string;
	private readonly _alias: string;

	constructor(
		public readonly parent: Scope,
		parentName: string,
		alias: string
	) {
		super();
		this._parentName = parentName.toLowerCase();
		this._alias = alias.toLowerCase();
	}

	resolveSymbol(symbolKey: string, expression: AST.Expression): PlanNode | typeof Ambiguous | undefined {
		const parts = symbolKey.split('.');

		// Handle schema-qualified symbols like "main.j.value"
		// NOTE: for a non-empty parent name this rewrites to "main.<parentName>.value" and asks
		// the parent, but a FROM source's RegisteredScope only holds BARE column names, so the
		// lookup always misses. Three-part column references are unsupported today either way
		// ("main.t.id isn't a column"). If they are ever supported, strip to the bare column name
		// here the way the two-part branch below does — the parent no longer falls back to the
		// enclosing query's scope (see registerColumnScope), so a miss now ends the search.
		if (parts.length === 3 && parts[1].toLowerCase() === this._alias) {
			// Replace alias with parent name: "main.j.value" -> "main..value" -> "main.value" (if parent name is empty)
			if (this._parentName === '') {
				// For table-valued functions, remove the alias entirely: "main.j.value" -> "value"
				return this.parent.resolveSymbol(parts[2], expression);
			} else {
				parts[1] = this._parentName;
				return this.parent.resolveSymbol(parts.join('.'), expression);
			}
		}
		// Handle qualified symbols like "j.value"
		else if (parts.length === 2 && parts[0].toLowerCase() === this._alias) {
			// For both cases (table-valued functions and regular tables),
			// just use the column name since the parent scope knows what table it represents
			return this.parent.resolveSymbol(parts[1], expression);
		}

		// For all other symbols (including unqualified columns), delegate to parent
		return this.parent.resolveSymbol(symbolKey, expression);
	}
}
