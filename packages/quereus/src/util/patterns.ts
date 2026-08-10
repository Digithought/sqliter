import { createLogger } from '../common/logger.js';

const log = createLogger('util:patterns');
const errorLog = log.extend('error');

/**
 * A compiled pattern matcher: given some text, returns whether it matches the
 * pattern the matcher was compiled from. Compilation (pattern → RegExp) happens
 * once; the returned closure is cheap to call per row.
 */
export type PatternMatcher = (text: string) => boolean;

/** Matcher used when a pattern fails to compile — matches nothing (as before). */
const NEVER_MATCH: PatternMatcher = () => false;

/**
 * Small bounded (LRU) cap for each compiled-pattern cache. A workload with many
 * distinct patterns evicts the least-recently-used entry rather than growing
 * the cache unboundedly.
 *
 * NOTE: 256 is an untuned guess. If a real workload thrashes distinct patterns
 * (cache-miss rate stays high), raise the cap or make it configurable.
 */
const PATTERN_CACHE_CAP = 256;

/**
 * Wrap a `compile` function with a bounded LRU cache so the same pattern string
 * is compiled at most once (until evicted). A `Map` preserves insertion order,
 * which gives a cheap LRU: on a hit re-insert the key to mark it most-recently
 * used; on overflow evict the oldest (first) key.
 *
 * NOTE: the cache key is the pattern string alone. LIKE and GLOB each get their
 * own cache (via separate `memoizeCompile` calls) so identical strings in the
 * two different pattern languages never collide. If LIKE `ESCAPE` or
 * case-insensitive matching is ever added, the escape char / case-fold flag
 * MUST become part of the key (or key each variant into its own cache), else
 * compiled matchers will collide across those variants.
 */
function memoizeCompile(compile: (pattern: string) => PatternMatcher): (pattern: string) => PatternMatcher {
	const cache = new Map<string, PatternMatcher>();
	return (pattern: string): PatternMatcher => {
		const cached = cache.get(pattern);
		if (cached !== undefined) {
			// Mark most-recently-used.
			cache.delete(pattern);
			cache.set(pattern, cached);
			return cached;
		}
		const matcher = compile(pattern);
		cache.set(pattern, matcher);
		if (cache.size > PATTERN_CACHE_CAP) {
			const oldest = cache.keys().next().value;
			if (oldest !== undefined) cache.delete(oldest);
		}
		return matcher;
	};
}

/**
 * Compile a SQL LIKE pattern into a matcher.
 * Supports SQL LIKE patterns:
 * - % matches any sequence of characters (including empty sequence)
 * - _ matches any single character
 */
function compileLike(pattern: string): PatternMatcher {
	// Escape regex special characters except % and _
	const escapedPattern = pattern.replace(/[.*+^${}()|[\]\\]/g, '\\$&');
	// Convert SQL LIKE wildcards to regex equivalents
	const regexPattern = escapedPattern.replace(/%/g, '.*').replace(/_/g, '.');

	try {
		// 'u' flag: match by Unicode code point so `_` matches one code point (incl. non-BMP)
		const regex = new RegExp(`^${regexPattern}$`, 'u');
		return (text: string): boolean => regex.test(text);
	} catch (e) {
		errorLog('Invalid LIKE pattern converted to regex: ^%s$, %O', regexPattern, e);
		return NEVER_MATCH;
	}
}

/**
 * Compile a SQL GLOB pattern into a matcher.
 * Supports SQL GLOB patterns:
 * - * matches any sequence of characters (including empty sequence)
 * - ? matches any single character
 */
function compileGlob(pattern: string): PatternMatcher {
	const chars = [...pattern]; // iterate by Unicode code point so non-BMP chars survive intact
	const regexMeta = '\\^$.|?*+()[]{}';
	let regex = '';
	let i = 0;

	while (i < chars.length) {
		const c = chars[i];

		if (c === '*') { regex += '.*'; i++; continue; }
		if (c === '?') { regex += '.'; i++; continue; }

		if (c === '[') {
			// Try to consume a character class. SQLite/glob: `]` immediately after `[` or `[^`
			// is a literal class member (handled here by emitting an escaped `]`).
			let j = i + 1;
			let cls = '[';
			if (j < chars.length && chars[j] === '^') { cls += '^'; j++; }
			let first = true;
			let closed = false;
			while (j < chars.length) {
				const cc = chars[j];
				if (cc === ']' && !first) { closed = true; break; }
				if (cc === '\\' || cc === ']') cls += '\\' + cc;
				else cls += cc;
				first = false;
				j++;
			}
			if (closed) { regex += cls + ']'; i = j + 1; continue; }
			// Unclosed `[` — fall through and treat as a literal `[`.
		}

		if (regexMeta.includes(c)) regex += '\\' + c;
		else regex += c;
		i++;
	}

	try {
		// 'u' flag: code-point ranges like `[😀-😎]` and `?`/`.` matching by code point.
		const compiled = new RegExp(`^${regex}$`, 'u');
		return (text: string): boolean => compiled.test(text);
	} catch (e) {
		errorLog('Invalid GLOB pattern compiled to regex: ^%s$, %O', regex, e);
		return NEVER_MATCH;
	}
}

/**
 * Compile (memoized) a LIKE pattern into a reusable matcher. Prefer this over
 * {@link simpleLike} when matching many texts against a pattern that is known
 * once (e.g. a literal-constant pattern captured at emit time): compile once,
 * call the returned matcher per row.
 */
export const compileLikeMatcher = memoizeCompile(compileLike);

/**
 * Compile (memoized) a GLOB pattern into a reusable matcher. See
 * {@link compileLikeMatcher}.
 */
export const compileGlobMatcher = memoizeCompile(compileGlob);

/**
 * Simple LIKE pattern matching. Compilation is memoized, so repeated calls with
 * the same pattern reuse a single compiled matcher.
 *
 * @param pattern The LIKE pattern
 * @param text The text to match against
 * @returns true if the text matches the pattern, false otherwise
 */
export function simpleLike(pattern: string, text: string): boolean {
	return compileLikeMatcher(pattern)(text);
}

/**
 * Simple GLOB pattern matching. Compilation is memoized, so repeated calls with
 * the same pattern reuse a single compiled matcher.
 *
 * @param pattern The GLOB pattern
 * @param text The text to match against
 * @returns true if the text matches the pattern, false otherwise
 */
export function simpleGlob(pattern: string, text: string): boolean {
	return compileGlobMatcher(pattern)(text);
}
