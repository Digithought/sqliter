import type { SqlValue } from '../../common/types.js';

/**
 * Key type used in B-Trees (primary key or index key part).
 *
 * **Invariant: the scalar-vs-tuple choice is a function of the structure's ARITY
 * alone, and is NEVER recoverable from the value.** A one-column primary key or
 * index stores the raw column value as a scalar; every other arity (including the
 * zero-column singleton PK, whose extractor returns `[]`) stores a `SqlValue[]`
 * tuple. See `utils/primary-key.ts` and {@link MemoryIndex}, which both branch on
 * arity when they build keys.
 *
 * Do NOT recover the shape with `Array.isArray`: a JSON column's value can itself
 * be a JS array, so a stored document like `[1]` would be misread as the one-element
 * tuple `(1)` and every bound/prefix check would then compare against `1`. Thread the
 * arity down instead and use {@link keyParts} / {@link leadingKeyPart}.
 */
export type BTreeKey = BTreeKeyForPrimary | BTreeKeyForIndex;

/** Alias for BTreeKey when explicitly referring to a primary key. */
export type BTreeKeyForPrimary = SqlValue | SqlValue[];

/** Alias for BTreeKey when explicitly referring to a key of a secondary index. */
export type BTreeKeyForIndex = SqlValue | SqlValue[];

/**
 * The tuple view of a key whose arity is already known — see the {@link BTreeKey}
 * invariant. `keyIsTuple` must come from the structure's column count, never from
 * inspecting the value.
 */
export function keyParts(key: BTreeKey, keyIsTuple: boolean): readonly SqlValue[] {
	return keyIsTuple ? key as SqlValue[] : [key as SqlValue];
}

/**
 * The leading component of a key whose arity is already known — `keyParts(...)[0]`
 * without allocating the single-element wrapper on the scalar path (this runs per
 * row inside scan loops).
 */
export function leadingKeyPart(key: BTreeKey, keyIsTuple: boolean): SqlValue {
	return keyIsTuple ? (key as SqlValue[])[0] : key as SqlValue;
}

/** Represents an entry in a MemoryIndex BTree, mapping an IndexKey to its PrimaryKeys.
 *
 * `primaryKeys` maps a **lossless, type-aware PK encoding** (see
 * `utils/primary-key-encode.ts`, bound to the table's PK arity and threaded into
 * {@link MemoryIndex} as `encode`) to the actual stored PK. The KEY gives O(1)
 * value-identity add/remove/dedup; the VALUE is the real {@link BTreeKeyForPrimary}
 * so scans yield real PKs and the PK comparator can sort them on read.
 *
 * It is a `Map` — NOT a JS `Set`, and NOT a class instance or nested BTree — for two
 * reasons:
 *  - *Value identity.* A `Set` keys members by SameValueZero/reference identity,
 *    wrong here: composite PKs are freshly-allocated arrays (so `Set.delete` of an
 *    equal-by-value key never matches and `Set.add` stores equal-by-value dupes),
 *    and even scalar integer PKs differ by representation (`5n` vs `5`). The encoding
 *    normalizes these so equal-by-comparator PKs share one Map key.
 *  - *Structured-clone safety.* The entry is stored as a value inside the secondary
 *    index `inheritree` BTree, whose node copy-on-write deep-clones stored entries via
 *    `structuredClone(this.entries)`. A `Map` round-trips through `structuredClone` as
 *    a `Map` (pure data); a class instance or nested BTree would not survive intact. */
export interface MemoryIndexEntry {
	indexKey: BTreeKeyForIndex;
	primaryKeys: Map<string, BTreeKeyForPrimary>;
}

/**
 * Configuration options for MemoryTable creation
 */
export interface MemoryTableConfig {
	readOnly?: boolean;
	_readCommitted?: boolean;
}
