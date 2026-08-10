/**
 * Shared byte-array helpers for encoded storage keys.
 *
 * Keys are compared as unsigned bytes, matching the lexicographic ordering
 * every KVStore implementation guarantees for `iterate()`.
 */

// NOTE: the ~10 other byte→hex encoders in `packages/quereus` (util/serialization.ts,
// util/key-tuple-codec.ts, vtab/memory/utils/primary-key-encode.ts, planner/analysis/*)
// duplicate this logic. They live in a different package with their own key concerns;
// consolidating them is a separate future cleanup, deliberately out of scope here.

/**
 * Precomputed two-char lowercase hex for every byte value (0x00–0xff).
 *
 * The output MUST stay lowercase, zero-padded, exactly two chars per byte:
 * {@link bytesToHex} keys are compared as strings in `InMemoryKVStore`, and
 * `[0-9a-f]` is the only alphabet where `localeCompare` on hex matches
 * unsigned-byte order (see `memory-store.ts` `compareHex`). Any other alphabet
 * (upper-case, unpadded) would silently mis-order every store test's oracle.
 */
const HEX_BYTE: readonly string[] = Array.from(
	{ length: 256 },
	(_unused, b) => b.toString(16).padStart(2, '0'),
);

/**
 * Hex-encode a key for use as a Map/Set lookup. Lowercase, two chars per byte —
 * see {@link HEX_BYTE} for the ordering contract callers depend on.
 */
export function bytesToHex(key: Uint8Array): string {
	let hex = '';
	for (let i = 0; i < key.length; i++) {
		hex += HEX_BYTE[key[i]];
	}
	return hex;
}

/** Byte-wise equality check for Uint8Arrays. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/**
 * Lexicographic unsigned-byte comparison — the same ordering KVStore
 * iteration yields. Negative when a < b, positive when a > b, 0 when equal.
 */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		if (a[i] !== b[i]) return a[i] - b[i];
	}
	return a.length - b.length;
}
