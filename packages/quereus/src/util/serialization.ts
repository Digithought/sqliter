/**
 * Utility functions for safe serialization, particularly handling BigInt and Uint8Arrays.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { createLogger } from '../common/logger.js';

const log = createLogger('util:serialization');
const errorLog = log.extend('error');

export function uint8ArrayToHex(bytes: Uint8Array): string {
	const hex: string[] = [];
	for (let i = 0; i < bytes.length; i++) {
		hex.push(bytes[i].toString(16).padStart(2, '0'));
	}
	return hex.join('');
}

/**
 * Maximum number of `Map` entries rendered in a `$map` serialization summary.
 * Matches the FD/binding/domain/IND bounding convention (`MAX_FDS_PER_NODE` /
 * `MAX_INDS_PER_NODE` in `planner/util/fd-utils.ts`, both 64): generous enough
 * that real physical summaries are never truncated in practice, present only to
 * bound worst-case EXPLAIN / `query_plan()` output. `size` always records the
 * true entry count even when the rendered entries are capped.
 */
export const MAP_SUMMARY_ENTRY_CAP = 64;

export function jsonStringify(obj: any, space?: string | number): string {
  return JSON.stringify(
		obj,
		(_, value) => {
			if (typeof value === 'bigint') {
				// Convert to number if it's within safe integer limits for JSON
				if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
					return Number(value);
				}
				// Otherwise, convert to string (without 'n' suffix for standard JSON)
				return value.toString();
			} else if (value instanceof Uint8Array) {
				return `0x${uint8ArrayToHex(value)}`;
			} else if (value instanceof Map) {
				// A Map has no enumerable own properties, so the default JSON path
				// renders it as `{}`. Emit a deterministic, bounded summary instead:
				// insertion-ordered [key, value] pairs plus the true `size`. The pairs
				// are plain values that re-enter this replacer, so nested bigint /
				// Uint8Array / Map values are still handled recursively (do not
				// pre-stringify them). Entries are capped at MAP_SUMMARY_ENTRY_CAP so a
				// large map cannot blow up EXPLAIN output; `size` still reflects the
				// full count. Keys (AttributeId numbers or strings) render as strings.
				const entries: [string, any][] = [];
				for (const [k, v] of value) {
					if (entries.length >= MAP_SUMMARY_ENTRY_CAP) break;
					entries.push([String(k), v]);
				}
				return { $map: entries, size: value.size };
			}
			return value;
		},
		space
	);
}

/**
 * Safely stringifies an object to JSON, converting BigInts to strings
 * ending with 'n' to avoid serialization errors.
 *
 * @param obj The object to stringify.
 * @param space Optional spacing argument for JSON.stringify.
 * @returns JSON string representation.
 */
export function safeJsonStringify(obj: any, space?: string | number): string {
  try {
    return jsonStringify(obj, space);
  } catch (e) {
    // Fallback in case of unexpected stringify errors
    errorLog("safeJsonStringify failed:", e);
    return `[Unserializable Object: ${e instanceof Error ? e.message : String(e)}]`;
  }
}
