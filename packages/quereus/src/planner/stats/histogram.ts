/**
 * Equi-height histogram utilities for selectivity estimation
 */

import { compareSqlValues } from '../../util/comparison.js';
import type { SqlValue } from '../../common/types.js';
import type { EquiHeightHistogram, HistogramBucket } from './catalog-stats.js';

/**
 * Estimate selectivity for a range predicate using a histogram.
 *
 * @param histogram The column's equi-height histogram
 * @param op Comparison operator: '>', '>=', '<', '<=', '='
 * @param value The constant value being compared
 * @param totalRows Total row count for the table
 * @returns Selectivity in [0, 1], or undefined if estimation fails
 */
export function selectivityFromHistogram(
	histogram: EquiHeightHistogram,
	op: string,
	value: SqlValue,
	totalRows: number
): number | undefined {
	const { buckets } = histogram;
	if (buckets.length === 0 || totalRows === 0) return undefined;

	// Find the bucket containing `value` via binary search on upperBound
	const idx = findBucket(buckets, value);
	const total = buckets[buckets.length - 1].cumulativeCount;
	if (total === 0) return 0;

	switch (op) {
		case '=':
		case '==': {
			// Point query: estimate 1/distinctCount within the containing bucket
			if (idx < 0 || idx >= buckets.length) return 0;
			const bucket = buckets[idx];
			return Math.min(1, 1 / Math.max(bucket.distinctCount, 1));
		}

		case '<': {
			if (idx < 0) return 0;
			if (idx >= buckets.length) return 1;
			return interpolateCumulative(buckets, idx, value) / total;
		}

		case '<=': {
			if (idx < 0) return 0;
			if (idx >= buckets.length) return 1;
			// Include the value itself
			const cum = interpolateCumulative(buckets, idx, value);
			return Math.min(1, cum / total);
		}

		case '>': {
			if (idx >= buckets.length) return 0;
			if (idx < 0) return 1;
			return 1 - (interpolateCumulative(buckets, idx, value) / total);
		}

		case '>=': {
			if (idx >= buckets.length) return 0;
			if (idx < 0) return 1;
			return 1 - (interpolateCumulative(buckets, idx, value) / total) +
				(1 / Math.max(buckets[idx]?.distinctCount ?? 1, 1) / total);
		}

		default:
			return undefined;
	}
}

/**
 * Build an equi-height histogram from sorted values.
 *
 * @param sortedValues Sorted array of non-null column values
 * @param numBuckets Target number of buckets
 * @returns Histogram, or undefined if too few values
 */
export function buildHistogram(
	sortedValues: SqlValue[],
	numBuckets: number
): EquiHeightHistogram | undefined {
	if (sortedValues.length === 0) return undefined;

	const n = sortedValues.length;
	const actualBuckets = Math.min(numBuckets, n);
	const bucketSize = n / actualBuckets;
	const buckets: HistogramBucket[] = [];

	for (let i = 0; i < actualBuckets; i++) {
		const start = Math.floor(i * bucketSize);
		const end = Math.floor((i + 1) * bucketSize);
		const upperIdx = Math.min(end - 1, n - 1);

		// Count distinct values within this bucket
		const distinct = new Set<string>();
		for (let j = start; j <= upperIdx; j++) {
			const val = sortedValues[j];
			// NOTE: String(val) collapses every JSON object to 'object:[object Object]',
			// so a JSON column's per-bucket NDV is undercounted. Harmless today — this is
			// a cost-estimation statistic only, never a correctness key. If JSON-column
			// cardinality ever drives a bad plan, key on canonicalJsonString here instead.
			distinct.add(typeof val + ':' + String(val));
		}

		buckets.push({
			upperBound: sortedValues[upperIdx],
			cumulativeCount: end,
			distinctCount: distinct.size
		});
	}

	return { buckets, sampleSize: n };
}

// ── Internals ───────────────────────────────────────────────────────────

/**
 * Binary search for the bucket whose upperBound >= value.
 * Returns the bucket index, or -1 if value < all bounds, or buckets.length if value > all bounds.
 */
function findBucket(buckets: readonly HistogramBucket[], value: SqlValue): number {
	let lo = 0;
	let hi = buckets.length - 1;

	// Value below first bucket
	if (compareSqlValues(value, buckets[0].upperBound) < 0) {
		// Could still be in the first bucket range
		return 0;
	}

	// Value above last bucket
	if (compareSqlValues(value, buckets[hi].upperBound) > 0) {
		return buckets.length;
	}

	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (compareSqlValues(buckets[mid].upperBound, value) < 0) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
}

/**
 * Linear interpolation of cumulative count at a value within a bucket.
 * Assumes uniform distribution within each bucket.
 */
function interpolateCumulative(
	buckets: readonly HistogramBucket[],
	idx: number,
	_value: SqlValue
): number {
	if (idx < 0) return 0;
	if (idx >= buckets.length) return buckets[buckets.length - 1].cumulativeCount;

	const bucket = buckets[idx];
	const prevCum = idx > 0 ? buckets[idx - 1].cumulativeCount : 0;
	const bucketRows = bucket.cumulativeCount - prevCum;

	// Without numeric distance computation (values may be non-numeric),
	// assume the value is at the midpoint of the bucket
	return prevCum + bucketRows / 2;
}
