/**
 * Byte helpers shared by the KVStore and KVStoreProvider conformance suites.
 *
 * Kept dependency-free (`node:assert/strict` only) for the same reason as the suites
 * themselves: this compiles into `@quereus/store`'s normal `src` build, so it must not
 * drag a test framework into the shipped package.
 */

import assert from 'node:assert/strict';

/**
 * Normalize a backend-returned buffer to a plain `Uint8Array`. LevelDB may hand back
 * a `Buffer` (a `Uint8Array` subclass), which `assert.deepStrictEqual` treats as a
 * DIFFERENT type from a plain `Uint8Array` of identical bytes — copying through
 * `new Uint8Array(x)` erases that prototype difference so content comparison is fair.
 */
export function u8(x: Uint8Array): Uint8Array {
	return new Uint8Array(x);
}

/** Assert a present value equals `expected` bytes (and is NOT the missing-key `undefined`). */
export function assertBytes(actual: Uint8Array | undefined, expected: Uint8Array, message?: string): void {
	assert.notStrictEqual(actual, undefined, message ?? 'expected a value, got undefined (missing key)');
	assert.deepStrictEqual(u8(actual as Uint8Array), u8(expected), message);
}

/** Build a `Uint8Array` from literal byte values — `b(1, 2)` is `x'0102'`. */
export const b = (...bytes: number[]): Uint8Array => new Uint8Array(bytes);
