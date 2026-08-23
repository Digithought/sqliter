/**
 * Capture of **which registered functions** a maintained table's body resolved to.
 *
 * A materialized view's backing rows are produced by the function registrations that
 * were live when its maintenance plan was built. Registration overwrites by
 * `(name, argument count)`, so a later `db.createAggregateFunction('sum', …)` can make
 * the same name mean something else without touching the stored rows. Comparing names
 * therefore proves nothing; the read-side rewrite compares the LIVE resolution of a
 * name against the schema captured here, by object identity.
 *
 * Written once per registration into
 * {@link import('../../schema/derivation.js').TableDerivation.bodyFunctions} and read by
 * the aggregate arm of `query-rewrite-matcher.ts`.
 */

import type * as AST from '../../parser/ast.js';
import { getFunctionKey, type FunctionSchema } from '../../schema/function.js';
import { walkAstNodes } from './predicate-shape.js';

/** Resolve a call site `(name, argc)` against the live function registry. Mirrors the
 *  planner's own lookup: exact arity first, then the variadic (`-1`) registration. */
export type BodyFunctionResolver = (name: string, argc: number) => FunctionSchema | undefined;

/**
 * Every function call anywhere in `body`, resolved against the live registry and keyed
 * by `getFunctionKey(name, argc)`. The walk is the reflective whole-body one
 * ({@link walkAstNodes}), so select-list items, WHERE, GROUP BY, HAVING, ORDER BY and
 * any nested subquery are all covered — a visitor enumeration cannot silently miss a
 * clause and leave a consumed function unwitnessed.
 *
 * A name resolving to nothing is simply absent; the read-side gate treats an absent
 * entry as "cannot vouch" and declines the rewrite (always safe — the query is computed
 * from the base tables instead).
 */
export function captureBodyFunctions(
	body: AST.QueryExpr,
	resolve: BodyFunctionResolver,
): ReadonlyMap<string, FunctionSchema> {
	const out = new Map<string, FunctionSchema>();
	for (const node of walkAstNodes(body)) {
		if (node.type !== 'function') continue;
		const fn = node as AST.FunctionExpr;
		const argc = fn.args?.length ?? 0;
		const key = getFunctionKey(fn.name, argc);
		if (out.has(key)) continue;
		const schema = resolve(fn.name, argc);
		if (schema) out.set(key, schema);
	}
	return out;
}
