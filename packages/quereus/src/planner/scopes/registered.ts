import { StatusCode } from '../../common/types.js';
import { QuereusError } from '../../common/errors.js';
import type { PlanNode } from '../nodes/plan-node.js';
import * as AST from '../../parser/ast.js';
import { type ReferenceCallback, type Scope, Ambiguous } from './scope.js';

/**
 * The Scope object provides context for symbol resolution during query planning.
 * It encapsulates the logic for looking up columns, parameters, functions, and CTEs
 * based on the current position in the PlanNode tree.
 */
export class RegisteredScope implements Scope {
	/** Symbols that have been registered in this scope. */
	private registeredSymbols: Map<string, ReferenceCallback> = new Map();

	/**
	 * Symbol keys that are ambiguous *in this scope* — a bare name shared by two
	 * or more registered outputs (e.g. two GROUP BY keys `i.id` and `c.id` whose
	 * base name is both `id`). `resolveSymbol` returns {@link Ambiguous} for these
	 * before delegating to the parent, so a bare reference raises the clear
	 * "ambiguous column name" error instead of silently binding to a parent-scope
	 * column (which for aggregate output would be the wrong, pre-aggregate value).
	 */
	private ambiguousSymbols: Set<string> = new Set();

	constructor(
		/** The parent scope, if any. The root scope of a query has no parent. */
		public readonly parent?: Scope,
	) { }

	/**
	 * Registers a symbol (like a table alias, CTE name, or parameter) with a factory function
	 * that can produce a ReferenceNode for it when encountered in an expression.
	 *
	 * @param symbolKey The unique string key for this symbol in the current scope.
	 *  For tables/aliases: lower-case name.
	 *  For qualified schema.table: "schema.table" (lower-case).
	 *  For parameters: ":name" or ":index".
	 * @param getReference A factory function that takes the matching symbol and the current Scope,
	 *  and returns an appropriate ReferenceNode.
	 */
	registerSymbol(symbolKey: string, getReference: ReferenceCallback): void {
		const lowerSymbolKey = symbolKey.toLowerCase();
		if (this.registeredSymbols.has(lowerSymbolKey)) {
			throw new QuereusError(`Symbol '${lowerSymbolKey}' already exists in the same scope.`, StatusCode.ERROR);
		}
		this.registeredSymbols.set(lowerSymbolKey, getReference);
	}

	/**
	 * Marks a symbol key as ambiguous in this scope. Unlike {@link registerSymbol}
	 * this never throws — the caller uses it deliberately when two outputs share a
	 * bare name. A marked key short-circuits {@link resolveSymbol} to
	 * {@link Ambiguous} even if a same-named symbol is also registered.
	 */
	markAmbiguous(symbolKey: string): void {
		this.ambiguousSymbols.add(symbolKey.toLowerCase());
	}

	resolveSymbol(symbolKey: string, expression: AST.Expression): PlanNode | typeof Ambiguous | undefined {
		const lowerSymbolKey = symbolKey.toLowerCase();
		if (this.ambiguousSymbols.has(lowerSymbolKey)) {
			return Ambiguous;
		}
		const reference = this.registeredSymbols.get(lowerSymbolKey);
		if (reference) {
			return reference(expression, this);
		}
		if (this.parent) {
			return this.parent.resolveSymbol(symbolKey, expression);
		}
		return undefined;
	}

	/**
	 * Returns all symbols that have been registered in this scope.
	 *
	 * @returns An array of all [symbolKey, ReferenceCallback].
	 */
	getSymbols(): readonly [string, ReferenceCallback][] {
		return Array.from(this.registeredSymbols.entries());
	}

	/**
	 * Returns all symbol keys marked ambiguous in this scope. Used when composing
	 * a derived scope (e.g. the HAVING hybrid scope) so the ambiguity carries over.
	 */
	getAmbiguousSymbols(): readonly string[] {
		return Array.from(this.ambiguousSymbols);
	}
}
