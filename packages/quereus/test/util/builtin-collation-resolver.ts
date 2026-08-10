import { builtinCollationResolver } from '../../src/util/comparison.js';
import type { CollationResolver } from '../../src/types/logical-type.js';

/**
 * A `CollationResolver` over the three built-in collations only, for tests that
 * construct memory-vtab internals (`MemoryIndex`, `createPrimaryKeyFunctions`,
 * `BaseLayer`) without a `Database`.
 *
 * Deliberately *not* a default parameter on those constructors: a memory table
 * must resolve collations against its own database, and a global fallback would
 * silently re-open that hole. Mirrors `Database.getCollationResolver()`'s
 * contract — unknown name throws, never degrades to BINARY.
 */
export const testBuiltinCollationResolver: CollationResolver = (name: string) => {
	const func = builtinCollationResolver(name);
	if (!func) throw new Error(`no such collation sequence: ${name}`);
	return func;
};
