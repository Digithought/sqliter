/**
 * Shared KVStore conformance suite — test-support; run under Mocha.
 *
 * ONE parameterized battery of behavioral tests written against the {@link KVStore}
 * contract (not against any single backend), invoked once per backend. Each backend
 * supplies only a small {@link KVBackend} adapter (how to open / reopen / tear down);
 * this file supplies every assertion. A behavior that drifts on one backend then
 * fails the suite instead of silently diverging across the three interchangeable
 * stores (in-memory, LevelDB, IndexedDB).
 *
 * Deps are deliberately minimal so this file can be compiled into `@quereus/store`'s
 * normal `src` build without dragging a test framework into the shipped package:
 *   - assertions use `node:assert/strict` (built-in, zero deps);
 *   - Mocha's `describe`/`it`/`beforeEach`/`afterEach` are referenced through a
 *     module-local ambient declaration below. Because this file has imports/exports
 *     the declarations are module-scoped (no global pollution, no `@types/mocha`
 *     needed at store build time); at runtime the real Mocha globals bind.
 *
 * The ordering ORACLE is `compareBytes` — the literal definition of the KVStore
 * iteration contract ("keys compared lexicographically by bytes") — NOT the in-memory
 * store, so the memory backend is tested against the contract as honestly as the
 * others.
 */

import assert from 'node:assert/strict';
import type { SqlValue } from '@quereus/quereus';
import type { KVStore, IterateOptions } from '../common/kv-store.js';
import { compareBytes } from '../common/bytes.js';
import { encodeCompositeKey } from '../common/encoding.js';
import { assertBytes, b, u8 } from './kv-assert.js';

// Module-local Mocha globals. Scoped to this module (the file is an ES module), so
// they shadow — never redeclare — any ambient `@types/mocha` globals present at
// store build time. The real Mocha functions bind at runtime.
declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => void | Promise<void>) => void;
declare const beforeEach: (fn: () => void | Promise<void>) => void;
declare const afterEach: (fn: () => void | Promise<void>) => void;

/**
 * Read instrumentation for the bounded-iteration tier.
 *
 * The battery only ever holds a {@link KVStore}; it cannot see what a backend reads
 * underneath. A backend supplies this by wrapping whatever its store reads FROM — the
 * level handle, the SQL driver, the IDB cursor — in its own adapter's closure.
 */
export interface ReadMeter {
	/**
	 * Entries read from backing storage so far — monotonically increasing over the
	 * adapter's lifetime. Callers take a baseline and measure the delta, so this never
	 * needs an explicit reset.
	 */
	entriesRead(): number;
	/**
	 * How many entries this backend may read ahead of one yield — its batch size.
	 * `abstract-level` awaits `next()` once per entry, so 1; IndexedDB pages 256.
	 * Count what the meter actually observes, including any extra probe read the
	 * implementation takes to discover a batch is full.
	 */
	maxReadAhead: number;
}

/**
 * Per-backend lifecycle adapter. The suite drives its own per-test lifecycle and
 * calls {@link makeBackend} fresh for every test, so state never leaks between tests.
 */
export interface KVBackend {
	/** Prepare backend state; return a fresh EMPTY store. Called once per test. */
	open(): Promise<KVStore>;
	/**
	 * Reopen the SAME physical keyspace {@link open} last created, WITHOUT wiping it —
	 * drives the persistence tier. Omit for a non-persistent backend (in-memory),
	 * and the persistence tier is not registered for that backend.
	 */
	reopen?(): Promise<KVStore>;
	/** Release everything open()/reopen() created (close handles, rm temp dir / delete db). */
	teardown(): Promise<void>;
	/**
	 * Optional read instrumentation for the bounded-iteration tier. Omit it and that
	 * tier's METERED cases are not registered for this backend (its unmetered cases —
	 * break and throw mid-iteration — still run). See {@link ReadMeter}.
	 */
	readMeter?: ReadMeter;
}

/**
 * Assert that `store.iterate(options)` reads a BOUNDED amount from backing storage:
 * consume `take` entries, then stop, and check the meter.
 *
 * The allowance is `take + maxReadAhead - 1`: a backend that reads one entry per yield
 * reads exactly `take`, and one that pages reads at most `take` rounded up past a batch
 * boundary. Crucially the allowance does NOT grow with the size of the range, so a
 * backend that materializes the whole range fails however large the range is — which is
 * the property the bounded-iteration tier exists to pin. Passing `take` = the whole range
 * pins the other half of the contract, that total work is linear: a backend paging by
 * `limit`/`offset` reads a bounded FIRST batch but O(n²) overall.
 *
 * Exported standalone so a spec can drive it against a deliberately-buffering store
 * double and prove it rejects (see `bounded-iterate.spec.ts`).
 *
 * @param store - The store under test.
 * @param meter - Read instrumentation for whatever `store` reads from.
 * @param options - Iterate options. The range must hold at least `take` entries.
 * @param take - Entries to consume before stopping. Default 1 (prefix-and-stop).
 */
export async function assertBoundedIterate(
	store: KVStore,
	meter: ReadMeter,
	options?: IterateOptions,
	take: number = 1,
): Promise<void> {
	assert.ok(take >= 1, `assertBoundedIterate: take must be >= 1, got ${take}`);
	const baseline = meter.entriesRead();

	let consumed = 0;
	for await (const _entry of store.iterate(options)) {
		if (++consumed >= take) break;
	}
	const read = meter.entriesRead() - baseline;

	// Guards against a vacuous pass: a store that yields nothing reads nothing, and a
	// meter wired to the wrong thing reports zero however the store behaves.
	assert.strictEqual(consumed, take,
		`expected to consume ${take} entries before stopping, got ${consumed} — the range is too small to measure`);
	assert.ok(read >= 1,
		'the read meter counted nothing — it is not wired to what this store reads from');

	const allowed = take + meter.maxReadAhead - 1;
	assert.ok(read <= allowed,
		`bounded iteration: consuming ${take} entr${take === 1 ? 'y' : 'ies'} read ${read} from backing storage, ` +
		`allowance is ${allowed} (take + maxReadAhead - 1, maxReadAhead=${meter.maxReadAhead})`);
}

// ============================================================================
// Assertion + iteration helpers
// ============================================================================

/** Collect the keys an iterate() yields, normalized to plain `Uint8Array`. */
async function keysOf(store: KVStore, options?: IterateOptions): Promise<Uint8Array[]> {
	const out: Uint8Array[] = [];
	for await (const entry of store.iterate(options)) out.push(u8(entry.key));
	return out;
}

/** `compareBytes`-sorted copy of a key list — the contract's expected iteration order. */
function sortedByBytes(keys: Uint8Array[]): Uint8Array[] {
	return [...keys].sort(compareBytes);
}

/** Seed single-byte keys 1..5 with value [i*10] — the shared range-bound fixture. */
async function seed1to5(store: KVStore): Promise<void> {
	for (let i = 1; i <= 5; i++) await store.put(b(i), b(i * 10));
}

/** 2-byte big-endian key for the large-range tiers (0..65535) — byte order matches key order. */
const enc = (n: number): Uint8Array => b((n >> 8) & 0xff, n & 0xff);
/** Inverse of {@link enc}. */
const dec = (k: Uint8Array): number => (k[0] << 8) | k[1];

// ============================================================================
// Tier 6 golden vector — cross-backend byte-ordering agreement
// ============================================================================

// Reorder-equal JSON objects: canonical encoding makes them the SAME key bytes, so a
// backend that stored both would collapse to one entry. Cast mirrors encoding.spec.ts.
const OBJ_A = { a: 1, b: 2 } as unknown as SqlValue;
const OBJ_B = { b: 2, a: 1 } as unknown as SqlValue;

/**
 * Curated SQL values whose encoded keys must iterate identically on every backend.
 * Each entry is a DISTINCT key; the collapse pairs (reorder-equal object, 5n vs 5.0)
 * are exercised separately below. Covers: null; a negative int; zero; ints that
 * interleave a real (2 < 2.5 < 3); the large-int64 double-tie (2^53 and 2^53+1 share
 * a nearest double); NOCASE text; blobs that must sort by content not length
 * (x'0102' < x'03'); and a JSON object.
 */
const GOLDEN: SqlValue[] = [
	null,
	-1000n,
	0n,
	2n,
	2.5,
	3n,
	9007199254740992n, // 2^53
	9007199254740993n, // 2^53 + 1 (rounds to the 2^53 double — needs the tie-break tail)
	'abc',
	'xyz',
	b(0x01, 0x02), // sorts BEFORE the shorter x'03' — content, not length
	b(0x03),
	OBJ_A,
];

/** A fixed, non-sorted permutation of GOLDEN's indices (0..12) for shuffled insertion. */
const GOLDEN_SHUFFLE = [7, 2, 11, 0, 5, 9, 1, 12, 4, 8, 3, 10, 6];

/** Encode one SQL value as a single-column composite key (default NOCASE collation). */
const key1 = (v: SqlValue): Uint8Array => encodeCompositeKey([v]);

// ============================================================================
// The suite
// ============================================================================

/**
 * Register the full KVStore conformance battery under `describe(name)`. Call once per
 * backend. `makeBackend` is invoked fresh for every test (so no state leaks); it is
 * also probed once at registration to decide whether the persistence tier applies.
 */
export function runKVStoreConformance(name: string, makeBackend: () => KVBackend): void {
	// Probe (no open()/teardown() — the factory only builds the adapter object) to
	// learn whether this backend persists across a reopen, and whether it can report
	// what it reads from backing storage.
	const probe = makeBackend();
	const supportsReopen = typeof probe.reopen === 'function';
	const supportsReadMeter = probe.readMeter !== undefined;

	describe(name, () => {
		let backend: KVBackend;
		let store: KVStore;

		beforeEach(async () => {
			backend = makeBackend();
			store = await backend.open();
		});

		afterEach(async () => {
			await backend.teardown();
		});

		// ------------------------------------------------------------------
		// Tier 1 — point operations
		// ------------------------------------------------------------------
		describe('tier 1: point operations', () => {
			it('put then get round-trips', async () => {
				await store.put(b(1, 2), b(10, 20));
				assertBytes(await store.get(b(1, 2)), b(10, 20));
			});

			it('get of a missing key is undefined', async () => {
				assert.strictEqual(await store.get(b(9, 9)), undefined);
			});

			it('an empty value round-trips and is distinct from a missing key', async () => {
				await store.put(b(1), b()); // empty value
				const got = await store.get(b(1));
				assert.notStrictEqual(got, undefined, 'empty value must not read back as missing');
				assert.strictEqual((got as Uint8Array).length, 0);
				// A genuinely absent key still reads undefined.
				assert.strictEqual(await store.get(b(2)), undefined);
			});

			it('an empty key is a valid key: put/get/has/delete round-trip', async () => {
				const empty = b();
				await store.put(empty, b(42));
				assertBytes(await store.get(empty), b(42));
				assert.strictEqual(await store.has(empty), true);
				await store.delete(empty);
				assert.strictEqual(await store.get(empty), undefined);
				assert.strictEqual(await store.has(empty), false);
			});

			it('overwrite replaces the value', async () => {
				await store.put(b(1), b(10));
				await store.put(b(1), b(20));
				assertBytes(await store.get(b(1)), b(20));
			});

			it('delete of a missing key is a no-op (no throw)', async () => {
				await store.delete(b(123)); // must not throw
				assert.strictEqual(await store.get(b(123)), undefined);
			});

			it('has agrees with get presence', async () => {
				assert.strictEqual(await store.has(b(1)), false);
				await store.put(b(1), b(10));
				assert.strictEqual(await store.has(b(1)), true);
				await store.delete(b(1));
				assert.strictEqual(await store.has(b(1)), false);
			});

			it('mutating the caller buffers after put does not change stored data', async () => {
				const key = b(1, 2, 3);
				const val = b(4, 5, 6);
				await store.put(key, val);
				key[0] = 99;
				val[0] = 99;
				assertBytes(await store.get(b(1, 2, 3)), b(4, 5, 6));
			});

			it('mutating a returned value does not corrupt the store', async () => {
				await store.put(b(1), b(10, 20));
				const first = await store.get(b(1));
				(first as Uint8Array)[0] = 99; // caller scribbles on the read buffer
				assertBytes(await store.get(b(1)), b(10, 20), 'a later read must be unaffected');
			});

			it('put/delete accept the { sync: true } WriteOptions hint and still persist', async () => {
				await store.put(b(7), b(70), { sync: true });
				assertBytes(await store.get(b(7)), b(70));
				await store.delete(b(7), { sync: true });
				assert.strictEqual(await store.get(b(7)), undefined);
			});

			it('get and put reject after close()', async () => {
				await store.close();
				await assert.rejects(() => store.get(b(1)), /closed/i);
				await assert.rejects(() => store.put(b(1), b(2)), /closed/i);
			});
		});

		// ------------------------------------------------------------------
		// Tier 2 — iteration & ordering
		// ------------------------------------------------------------------
		describe('tier 2: iteration & ordering', () => {
			it('empty store yields nothing and approximateCount is 0', async () => {
				assert.deepStrictEqual(await keysOf(store), []);
				assert.strictEqual(await store.approximateCount(), 0);
			});

			it('forward iterate returns compareBytes order; reverse returns the exact reverse', async () => {
				// Byte extremes (0x00, 0xff) and prefix/extension relationships.
				const keys = [
					b(0x00), b(0x00, 0x00), b(0x01), b(0x01, 0x00), b(0x01, 0x01),
					b(0x02), b(0x7f), b(0x80), b(0xff), b(0xff, 0x00),
				];
				// Insert in a scrambled order so ordering can't come from insertion order.
				for (const k of [...keys].reverse()) await store.put(k, b(1));
				const expected = sortedByBytes(keys);
				assert.deepStrictEqual(await keysOf(store), expected);
				assert.deepStrictEqual(await keysOf(store, { reverse: true }), [...expected].reverse());
			});

			it('a proper prefix sorts before its extensions ([1] < [1,0] < [1,1])', async () => {
				for (const k of [b(1, 1), b(1), b(1, 0)]) await store.put(k, b(1));
				assert.deepStrictEqual(await keysOf(store), [b(1), b(1, 0), b(1, 1)]);
			});

			it('honors each bound individually and combined', async () => {
				await seed1to5(store);
				assert.deepStrictEqual(await keysOf(store, { gte: b(3) }), [b(3), b(4), b(5)]);
				assert.deepStrictEqual(await keysOf(store, { gt: b(3) }), [b(4), b(5)]);
				assert.deepStrictEqual(await keysOf(store, { lte: b(3) }), [b(1), b(2), b(3)]);
				assert.deepStrictEqual(await keysOf(store, { lt: b(3) }), [b(1), b(2)]);
				assert.deepStrictEqual(await keysOf(store, { gte: b(2), lt: b(4) }), [b(2), b(3)]);
				assert.deepStrictEqual(await keysOf(store, { gt: b(1), lt: b(5) }), [b(2), b(3), b(4)]);
			});

			it('honors bounds with reverse', async () => {
				await seed1to5(store);
				assert.deepStrictEqual(await keysOf(store, { gte: b(2), lte: b(4), reverse: true }), [b(4), b(3), b(2)]);
				assert.deepStrictEqual(await keysOf(store, { gt: b(1), lt: b(5), reverse: true }), [b(4), b(3), b(2)]);
			});

			it('a crossed or empty range yields nothing (no throw)', async () => {
				await seed1to5(store);
				assert.deepStrictEqual(await keysOf(store, { gte: b(4), lt: b(2) }), []); // crossed
				assert.deepStrictEqual(await keysOf(store, { gte: b(3), lt: b(3) }), []); // empty point
				assert.deepStrictEqual(await keysOf(store, { gt: b(3), lte: b(3) }), []); // excluded point
				assert.deepStrictEqual(await keysOf(store, { gte: b(90) }), []); // above all
			});

			it('honors limit (0, oversized, and with reverse)', async () => {
				await seed1to5(store);
				assert.deepStrictEqual(await keysOf(store, { limit: 0 }), []);
				assert.deepStrictEqual(await keysOf(store, { limit: 2 }), [b(1), b(2)]);
				assert.deepStrictEqual(await keysOf(store, { limit: 99 }), [b(1), b(2), b(3), b(4), b(5)]);
				assert.deepStrictEqual(await keysOf(store, { reverse: true, limit: 2 }), [b(5), b(4)]);
			});

			it('yields COPIES: mutating a yielded key/value cannot corrupt the store', async () => {
				// Iteration's read-buffer contract mirrors get() — a consumer scribbling on a
				// yielded entry must not reach the store's internal buffers. (Regression guard
				// for the in-memory backend, which once yielded its internal buffers directly;
				// LevelDB/IndexedDB hand back fresh buffers per read.)
				await seed1to5(store);
				for await (const entry of store.iterate()) {
					entry.key[0] = 0x99;
					entry.value[0] = 0x99;
				}
				assert.deepStrictEqual(await keysOf(store), [b(1), b(2), b(3), b(4), b(5)]);
				assertBytes(await store.get(b(3)), b(30), 'a value read after mutating an iterated entry must be intact');
			});

			it('approximateCount(range) equals the actual count over that range', async () => {
				await seed1to5(store);
				assert.strictEqual(await store.approximateCount(), 5);
				assert.strictEqual(await store.approximateCount({ gte: b(2), lt: b(4) }), 2);
				assert.strictEqual(await store.approximateCount({ gte: b(90) }), 0);
			});
		});

		// ------------------------------------------------------------------
		// Tier 3 — streaming iteration (bounded, crosses IndexedDB's 256-entry batch)
		// ------------------------------------------------------------------
		describe('tier 3: streaming iteration across a batch boundary', () => {
			const COUNT = 306; // > 256 so iteration crosses at least one IndexedDB page boundary

			beforeEach(async () => {
				const batch = store.batch();
				for (let i = 0; i < COUNT; i++) batch.put(enc(i), b(i & 0xff));
				await batch.write();
			});

			it('streams every entry once, ascending, while awaiting an unrelated get each step', async () => {
				const seen: number[] = [];
				for await (const entry of store.iterate()) {
					// Await an unrelated op mid-loop: a naive single-cursor IDB iterate would let
					// its readonly tx auto-commit here and throw TransactionInactiveError next step.
					await store.get(enc(0));
					seen.push(dec(entry.key));
				}
				assert.strictEqual(seen.length, COUNT);
				for (let i = 0; i < COUNT; i++) assert.strictEqual(seen[i], i, `entry ${i}`);
			});

			it('honors reverse across the batch boundary', async () => {
				const seen: number[] = [];
				for await (const entry of store.iterate({ reverse: true })) seen.push(dec(entry.key));
				assert.strictEqual(seen.length, COUNT);
				for (let i = 0; i < COUNT; i++) assert.strictEqual(seen[i], COUNT - 1 - i);
			});

			it('honors a limit that spans the batch boundary', async () => {
				const limit = 300;
				const seen: number[] = [];
				for await (const entry of store.iterate({ limit })) seen.push(dec(entry.key));
				assert.strictEqual(seen.length, limit);
				assert.strictEqual(seen[0], 0);
				assert.strictEqual(seen[limit - 1], limit - 1);
			});

			it('handles an inclusive upper bound landing on an exact batch multiple (no DataError)', async () => {
				// [0..255] is exactly one 256-entry batch and its max key equals the inclusive
				// lte bound — the resume edge collapses to an empty range that must read as
				// "exhausted", never throw. Regression from plugins-indexeddb-diverges.
				const seen: number[] = [];
				for await (const entry of store.iterate({ lte: enc(255) })) seen.push(dec(entry.key));
				assert.strictEqual(seen.length, 256);
				assert.strictEqual(seen[0], 0);
				assert.strictEqual(seen[255], 255);
			});

			it('handles an inclusive lower bound landing on an exact reverse batch multiple', async () => {
				// Reverse mirror: [50..305] is exactly 256, its min key equals the inclusive gte
				// bound, and reverse resumes on the upper edge.
				const seen: number[] = [];
				for await (const entry of store.iterate({ gte: enc(50), reverse: true })) seen.push(dec(entry.key));
				assert.strictEqual(seen.length, 256);
				assert.strictEqual(seen[0], 305);
				assert.strictEqual(seen[255], 50);
			});
		});

		// ------------------------------------------------------------------
		// Tier 4 — batch
		// ------------------------------------------------------------------
		describe('tier 4: batch', () => {
			it('nothing is visible until write(), then all ops apply', async () => {
				const batch = store.batch();
				batch.put(b(1), b(10));
				batch.put(b(2), b(20));
				assert.strictEqual(await store.has(b(1)), false, 'not visible before write()');
				await batch.write();
				assertBytes(await store.get(b(1)), b(10));
				assertBytes(await store.get(b(2)), b(20));
			});

			it('mixed put + delete in one batch apply together', async () => {
				await store.put(b(1), b(10));
				const batch = store.batch();
				batch.delete(b(1));
				batch.put(b(2), b(20));
				await batch.write();
				assert.strictEqual(await store.get(b(1)), undefined);
				assertBytes(await store.get(b(2)), b(20));
			});

			it('put then delete on the same key in one batch leaves it absent (key pre-existing)', async () => {
				await store.put(b(1), b(10));
				const batch = store.batch();
				batch.put(b(1), b(20));
				batch.delete(b(1));
				await batch.write();
				assert.strictEqual(await store.get(b(1)), undefined);
			});

			it('put then delete on the same key in one batch leaves it absent (key new)', async () => {
				const batch = store.batch();
				batch.put(b(1), b(20));
				batch.delete(b(1));
				await batch.write();
				assert.strictEqual(await store.get(b(1)), undefined);
			});

			it('delete then put on the same key in one batch leaves the put value', async () => {
				await store.put(b(1), b(10));
				const batch = store.batch();
				batch.delete(b(1));
				batch.put(b(1), b(20));
				await batch.write();
				assertBytes(await store.get(b(1)), b(20));
			});

			it('a run of same-key ops in one batch resolves to the last op queued', async () => {
				const batch = store.batch();
				batch.put(b(1), b(10)); // a
				batch.put(b(1), b(20)); // b
				batch.delete(b(1));
				batch.put(b(1), b(30)); // c
				await batch.write();
				assertBytes(await store.get(b(1)), b(30));
			});

			it('a committed batch does not re-apply its ops on reuse', async () => {
				const batch = store.batch();
				batch.put(b(1), b(11));
				await batch.write();
				assertBytes(await store.get(b(1)), b(11));

				// Remove k1 out-of-band, then reuse the same batch handle.
				await store.delete(b(1));
				batch.put(b(2), b(22));
				await batch.write();

				// If write() had not cleared ops, the second commit would resurrect k1.
				assert.strictEqual(await store.get(b(1)), undefined);
				assertBytes(await store.get(b(2)), b(22));
			});

			it('clear() discards queued ops', async () => {
				const batch = store.batch();
				batch.put(b(1), b(10));
				batch.clear();
				await batch.write();
				assert.strictEqual(await store.has(b(1)), false);
			});

			it('an empty batch write() is a no-op (no throw)', async () => {
				await store.batch().write(); // must not throw
				assert.strictEqual(await store.approximateCount(), 0);
			});
		});

		// ------------------------------------------------------------------
		// Tier 5 — persistence (only registered when the adapter provides reopen)
		// ------------------------------------------------------------------
		if (supportsReopen) {
			describe('tier 5: persistence across reopen', () => {
				it('data written before close is present after reopen', async () => {
					await store.put(b(1, 2, 3), b(4, 5, 6));
					await store.put(b(9), b(9, 9));
					// reopen() closes the current handle and reopens the SAME keyspace, no wipe.
					store = await (backend.reopen as () => Promise<KVStore>)();
					assertBytes(await store.get(b(1, 2, 3)), b(4, 5, 6));
					assertBytes(await store.get(b(9)), b(9, 9));
					assert.strictEqual(await store.approximateCount(), 2);
				});
			});
		}

		// ------------------------------------------------------------------
		// Tier 6 — cross-backend byte-ordering agreement (the encoding coupling)
		// ------------------------------------------------------------------
		describe('tier 6: encoded-key ordering agreement', () => {
			it('iterates shuffled encoded keys in compareBytes order (forward and reverse)', async () => {
				const encoded = GOLDEN.map(key1);
				// Guard: the curated vector must be all-distinct, else the count assertions below
				// would silently pass with a collision masking a missing key.
				assert.strictEqual(new Set(encoded.map((k) => k.join(','))).size, encoded.length,
					'GOLDEN must encode to distinct keys');

				for (const idx of GOLDEN_SHUFFLE) await store.put(encoded[idx], b(idx));
				const expected = sortedByBytes(encoded);
				assert.deepStrictEqual(await keysOf(store), expected);
				assert.deepStrictEqual(await keysOf(store, { reverse: true }), [...expected].reverse());
			});

			it('reorder-equal JSON objects collapse to a single stored entry', async () => {
				await store.put(key1(OBJ_A), b(1));
				await store.put(key1(OBJ_B), b(2)); // same key bytes → overwrites
				assert.strictEqual(await store.approximateCount(), 1);
				assertBytes(await store.get(key1(OBJ_A)), b(2));
			});

			it('5n and 5.0 encode to one key and collapse to a single stored entry', async () => {
				await store.put(key1(5n), b(1));
				await store.put(key1(5), b(2)); // 5.0 → identical numeric key → overwrites
				assert.strictEqual(await store.approximateCount(), 1);
				assertBytes(await store.get(key1(5n)), b(2));
			});
		});

		// ------------------------------------------------------------------
		// Tier 7 — bounded iteration (see KVStore.iterate's contract)
		//
		// The unmetered cases run everywhere: they pin that abandoning an iteration
		// releases whatever the backend held. The metered cases need the adapter to
		// supply a ReadMeter, because a KVStore handle cannot see its own reads.
		// ------------------------------------------------------------------
		describe('tier 7: bounded iteration', () => {
			it('breaking out mid-iteration leaves the store usable and closeable', async () => {
				await seed1to5(store);
				let seen = 0;
				for await (const _entry of store.iterate()) {
					seen++;
					break;
				}
				assert.strictEqual(seen, 1);
				// An iterator/transaction left open by the abandoned scan would wedge these.
				assertBytes(await store.get(b(3)), b(30));
				assert.deepStrictEqual(await keysOf(store), [b(1), b(2), b(3), b(4), b(5)]);
				await store.close(); // must resolve, not hang on an unreleased handle
			});

			it('an exception thrown from the loop body propagates and leaves the store usable', async () => {
				await seed1to5(store);
				await assert.rejects(async () => {
					for await (const _entry of store.iterate()) {
						throw new Error('consumer boom');
					}
				}, /consumer boom/);
				assertBytes(await store.get(b(3)), b(30));
				assert.deepStrictEqual(await keysOf(store), [b(1), b(2), b(3), b(4), b(5)]);
			});

			if (supportsReadMeter) {
				describe('metered: reads stay bounded regardless of range size', () => {
					let meter: ReadMeter;
					let count: number;

					beforeEach(async () => {
						meter = backend.readMeter as ReadMeter;
						// Big enough that a backend materializing the range blows the allowance
						// by orders of magnitude, whatever its batch size is. Several batches
						// deep, so the full-drain case below actually exercises resumption.
						count = Math.max(3 * meter.maxReadAhead, 512);
						const batch = store.batch();
						for (let i = 0; i < count; i++) batch.put(enc(i), b(i & 0xff));
						await batch.write();
					});

					it('an unbounded iterate stopped after one entry reads at most one batch', async () => {
						await assertBoundedIterate(store, meter);
					});

					it('the same holds in reverse', async () => {
						await assertBoundedIterate(store, meter, { reverse: true });
					});

					it('a small limit costs the limit, not the range', async () => {
						// NOTE: on a backend whose batch is much larger than 5 this case adds
						// little over the unbounded one — the allowance is dominated by
						// maxReadAhead, so it cannot tell "pushed the limit down" from "read a
						// whole batch". It is exact for a one-entry-per-yield backend. If a
						// backend ever needs its limit pushdown pinned specifically, assert on
						// a limit LARGER than its batch instead of adding slack here.
						await assertBoundedIterate(store, meter, { limit: 5 }, 5);
					});

					it('draining the whole range costs about one read per entry', async () => {
						// Prefix cases above cannot see a backend that pages by re-reading from
						// the start and discarding a growing prefix (`limit`/`offset` paging):
						// its FIRST batch is bounded, and only the total goes quadratic.
						await assertBoundedIterate(store, meter, undefined, count);
					});
				});
			}
		});
	});
}
