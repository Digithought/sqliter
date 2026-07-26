/**
 * Structural ("spine") clone of an AST subtree: plain objects and arrays are
 * deep-copied, everything else is passed through **by reference**.
 *
 * Exists for the in-place AST rewriters (`schema/rename-rewriter.ts`), which
 * mutate the node graph they are handed and report whether anything changed. A
 * caller that wants to compute what a rewrite *would* produce — without touching
 * the live catalog AST — must rewrite a copy instead.
 *
 * Why not `structuredClone`: `AST.LiteralExpr.value` is typed
 * `MaybePromise<SqlValue>`, and a Promise is not structured-cloneable — a live
 * body carrying one would throw `DataCloneError`. The rewriters only ever assign
 * to string fields (`.name`, `.schema`, `.table`, `.column`) and replace string
 * arrays on plain AST nodes, so copying the plain-object/array spine is enough:
 * every leaf they mutate is freshly owned, and every leaf they do not touch
 * (primitives, `Uint8Array`, `bigint`, class instances, Promises) can safely stay
 * shared.
 *
 * Frozen inputs are fine — the copy is unfrozen. Assumes a tree (the parser emits
 * no cycles); a cyclic graph would recurse without bound.
 */
export function spineCloneAst<T>(node: T): T {
	return spineClone(node) as T;
}

function spineClone(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(spineClone);
	if (value === null || typeof value !== 'object') return value;
	// Anything with a non-plain prototype (Uint8Array, Date, Map, Promise, any
	// class instance) is a leaf the rewriters never write into — share it.
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return value;
	const out: Record<string, unknown> = {};
	for (const [key, v] of Object.entries(value)) {
		out[key] = spineClone(v);
	}
	return out;
}
