/**
 * Shared batch/resume loop for KVStore backends that cannot stream.
 *
 * Some backends have no cursor to hold open across a consumer `await`: a SQL
 * `select` hands back a whole result set, and an IndexedDB readonly transaction
 * auto-commits while idle. Those backends satisfy {@link KVStore.iterate}'s
 * bounded-peak requirement by paging — read a fixed-size batch, yield it, resume
 * just past the last key seen — so peak memory is one batch regardless of how many
 * entries the range holds.
 *
 * The resume edge is the subtle part, and the reason this lives in one place rather
 * than being re-derived per backend:
 *   - forward tightens the LOWER bound, reverse tightens the UPPER bound, both
 *     EXCLUSIVE so no entry is yielded twice;
 *   - the resume key is captured BEFORE yielding, because entries are handed to the
 *     consumer by reference and a consumer that mutates a yielded key must not
 *     perturb where the next batch resumes from;
 *   - an exhausted edge can collapse the bounds to an empty range, which must read
 *     as "exhausted" rather than throw.
 */

import { compareBytes } from './bytes.js';
import type { IterateOptions, KVEntry } from './kv-store.js';

/** Default entries per batch when the caller does not pick one. */
const DEFAULT_BATCH_SIZE = 256;

/**
 * Fetch up to `want` entries for the given bounds.
 *
 * `bounds` is already resume-adjusted and carries `reverse`; it never carries
 * `limit` — the cap is `want`, passed separately so a backend can push it into its
 * query. Returning FEWER than `want` entries signals the range is exhausted, so an
 * implementation must return a full batch whenever one is available. Returning MORE
 * than `want` is a programming error and {@link pagedIterate} throws on it.
 */
export type FetchBatch = (bounds: IterateOptions, want: number) => Promise<KVEntry[]>;

/** A single edge of a key range: the boundary key and whether it is exclusive (`open`). */
interface Edge {
	key: Uint8Array;
	open: boolean;
}

/** Derive the lower/upper edges of `options`, preferring the inclusive form. */
function edgesOf(options: IterateOptions | undefined): { lower?: Edge; upper?: Edge } {
	let lower: Edge | undefined;
	let upper: Edge | undefined;
	if (options?.gte) lower = { key: options.gte, open: false };
	else if (options?.gt) lower = { key: options.gt, open: true };
	if (options?.lte) upper = { key: options.lte, open: false };
	else if (options?.lt) upper = { key: options.lt, open: true };
	return { lower, upper };
}

/**
 * True when the edges describe a range that can hold nothing: crossed, or a single
 * point excluded by either edge. Reached on the resume iteration when a batch fills
 * exactly to a boundary key that also equals an inclusive opposite bound.
 */
function isEmptyRange(lower: Edge | undefined, upper: Edge | undefined): boolean {
	if (!lower || !upper) return false;
	const c = compareBytes(lower.key, upper.key);
	return c > 0 || (c === 0 && (lower.open || upper.open));
}

/** Rebuild an {@link IterateOptions} from explicit edges, dropping `limit`. */
function boundsOf(lower: Edge | undefined, upper: Edge | undefined, reverse: boolean): IterateOptions {
	const bounds: IterateOptions = {};
	if (lower) {
		if (lower.open) bounds.gt = lower.key;
		else bounds.gte = lower.key;
	}
	if (upper) {
		if (upper.open) bounds.lt = upper.key;
		else bounds.lte = upper.key;
	}
	if (reverse) bounds.reverse = true;
	return bounds;
}

/**
 * Drive a non-streaming backend as a bounded async iterable: fetch a batch, yield it,
 * resume past the last key seen. Peak is one batch regardless of range size, and a
 * consumer that stops after k entries costs at most one batch beyond k.
 *
 * @param options - The caller's iterate options (bounds, `reverse`, `limit`).
 * @param fetchBatch - Backend read for one batch. See {@link FetchBatch}.
 * @param batchSize - Entries per batch. Defaults to {@link DEFAULT_BATCH_SIZE}.
 */
export async function* pagedIterate(
	options: IterateOptions | undefined,
	fetchBatch: FetchBatch,
	batchSize: number = DEFAULT_BATCH_SIZE,
): AsyncIterable<KVEntry> {
	if (!Number.isInteger(batchSize) || batchSize < 1) {
		throw new Error(`pagedIterate: batchSize must be a positive integer, got ${batchSize}`);
	}

	const reverse = options?.reverse ?? false;
	const { lower, upper } = edgesOf(options);
	let remaining = options?.limit; // undefined ⇒ unbounded
	let resumeKey: Uint8Array | undefined; // last key yielded — exclusive resume edge

	for (;;) {
		if (remaining !== undefined && remaining <= 0) return;
		const want = remaining === undefined ? batchSize : Math.min(batchSize, remaining);

		// Resume just past the last key seen: forward tightens the lower bound,
		// reverse tightens the upper bound — exclusive so no entry repeats.
		const effLower = !reverse && resumeKey !== undefined ? { key: resumeKey, open: true } : lower;
		const effUpper = reverse && resumeKey !== undefined ? { key: resumeKey, open: true } : upper;
		if (isEmptyRange(effLower, effUpper)) return;

		const batch = await fetchBatch(boundsOf(effLower, effUpper, reverse), want);
		if (batch.length > want) {
			throw new Error(`pagedIterate: fetchBatch returned ${batch.length} entries for want=${want}`);
		}

		// Capture the resume boundary BEFORE yielding, and as a COPY: entries go to the
		// consumer by reference, and a consumer that mutates a yielded key must not move
		// where the next batch resumes from.
		const nextResumeKey = batch.length > 0 ? new Uint8Array(batch[batch.length - 1].key) : undefined;
		for (const entry of batch) {
			yield entry;
		}
		if (remaining !== undefined) remaining -= batch.length;
		if (batch.length < want) return; // range exhausted before filling the batch
		resumeKey = nextResumeKey;
	}
}
