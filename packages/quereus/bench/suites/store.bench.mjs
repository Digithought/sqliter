/**
 * Store key building, priced on its own.
 *
 * `execution` and `mutation` measure whole queries against a storage backend. That is the
 * right top-level signal and a poor diagnostic: a full scan blends key decoding, iteration,
 * row deserialization and the isolation overlay into one number, so a regression in any one
 * of them reads as "the scan got slower". Key building runs once per row per index, is a
 * pure function of its inputs — no `Database`, no provider, no statement — and is therefore
 * the cheapest piece to measure directly.
 *
 * A STORE-ONLY SUITE, SO ITS NAMES CARRY NO `@` SUFFIX. `execution` and `mutation` hold
 * workloads that `bench/lib/backends.mjs` expands across every backend, and the bare name in
 * those suites means "the engine's default vtab module". Nothing here runs a query, so there
 * is no storage engine to swap underneath it: every benchmark below calls `@quereus/store`
 * directly and the bare name means exactly that. The invariant `docs/benchmarking.md` states
 * — every entry of BOTH those suites is expanded — is untouched; this is a third suite that
 * is not in the backend dimension at all.
 *
 * NO `counters()` PASS, for the same reason `parser` declares none: there is no `Database`,
 * no plan and no storage traffic, so nothing the work counters count. The absence is the
 * honest report, not an oversight.
 *
 * REACHING THE STORE PACKAGE. Through `bench/lib/store-counters.mjs` and nothing else. That
 * file's header says why: the parent process imports every suite file purely to enumerate
 * benchmark names, so a second import site is a second way for an unbuilt
 * `packages/quereus-store/dist` to kill the whole `yarn bench` run — parser and planner
 * included. `skipUnlessStoreLoads` below turns that same failure into a stated reason per
 * row, on every benchmark in the suite.
 *
 * PUBLIC EXPORTS ONLY. `buildDataKey`, `buildIndexKey`, `encodeCompositeKey`,
 * `decodeCompositeKey` and `BUILTIN_KEY_NORMALIZER_RESOLVER` are all part of
 * `@quereus/store`'s public surface (`packages/quereus-store/src/common/index.ts`). Binding
 * to those means this suite breaks at a deliberate API change rather than at an internal
 * refactor.
 */

import { loadStoreKeyApi, storeLoadFailure } from '../lib/store-counters.mjs';

/**
 * Why this suite's rows cannot run here, or `null` to run them.
 *
 * Same answer, and the same stated reason, the `@store-mem` rows give when
 * `packages/quereus-store/dist` is absent or stale. Without it every row here would fail
 * inside `setup` with a module-resolution stack trace instead of declining with a sentence.
 *
 * ONE definition shared by every benchmark below rather than a `skip()` body per factory:
 * they all decline for exactly one reason, and a second copy is a second thing to forget
 * when a benchmark is added.
 */
const skipUnlessStoreLoads = () => storeLoadFailure();

/**
 * How many keys one `fn` call builds.
 *
 * WHY AMORTIZE AT ALL. The worker calls `await fn()` per iteration
 * (`collectSamples` in `bench/lib/calibrate.mjs`). One `encodeValue` of an integer costs on
 * the order of a hundred nanoseconds; the `await` around it costs a microtask tick. Timing a
 * single key build per call would report mostly harness overhead, and a real regression in
 * the encoder would be invisible underneath it.
 *
 * ONE SHARED CONSTANT for every shape below, so the shapes stay directly comparable to each
 * other — `data-key-text-astral` against `data-key-text-binary` is the whole point of having
 * both, and that comparison is meaningless if the two build different numbers of keys.
 *
 * EVERY FIGURE IN THIS SUITE IS THEREFORE THE COST OF {@link KEYS_PER_CALL} KEY BUILDS,
 * not of one. Divide before quoting a per-key number.
 */
const KEYS_PER_CALL = 1000;

/**
 * How many DISTINCT fixture rows each benchmark cycles through. Small enough to stay in
 * cache (the subject is the encoder, not the memory system) and large enough that the
 * measurement is not one value's branch history repeated a thousand times.
 */
const DISTINCT_ROWS = 16;

/**
 * A fixture row: the values a key is built from, and what those values decode back to.
 *
 * `decodesTo` is stated rather than derived. Deriving it would mean re-implementing the
 * encoder's own normalization here (NOCASE folds text to lower case; an integer-valued
 * numeric decodes as a `bigint` whatever it was encoded from), and a mirror of the thing
 * under test verifies nothing — it drifts with it. Omitted where the row decodes to itself.
 *
 * @typedef {object} FixtureRow
 * @property {import('@quereus/quereus').SqlValue[]} values
 * @property {import('@quereus/quereus').SqlValue[]} [decodesTo] defaults to `values`
 */

/**
 * One key shape to measure.
 *
 * @typedef {object} KeyShape
 * @property {string} name benchmark name, unique within this suite
 * @property {FixtureRow[]} rows the distinct fixture rows, cycled to {@link KEYS_PER_CALL}
 * @property {string} collation the collation every text member encodes under. Stated on
 *   EVERY shape and never left to the default, because `encodeValue`'s default is `NOCASE`,
 *   not `BINARY` — a benchmark meaning to price the plain-text path and omitting this would
 *   silently measure the normalizer path, and the `NOCASE` benchmark beside it would then
 *   measure the same thing. Only BINARY / NOCASE / RTRIM are resolvable; see
 *   `BUILTIN_KEY_NORMALIZER_RESOLVER`, which raises on any other name rather than guessing.
 * @property {boolean} [descending] encode EVERY column DESC (the encoder bit-inverts each
 *   column's bytes in place). All-or-nothing rather than per-column, so `setup`'s round trip
 *   can un-invert the whole key without tracking where each column's bytes start.
 */

/** Text long enough that the UTF-8 encode is not lost in call overhead, and varied. */
const TEXTS = Array.from({ length: DISTINCT_ROWS }, (_, i) =>
	`customer-${String(i).padStart(4, '0')}-Northwind Trading Co`);

/**
 * Each of {@link TEXTS} with four astral-plane characters appended. Every one is a
 * well-formed surrogate PAIR, so `findUnpairedSurrogate`'s `HAS_SURROGATE` pre-test MATCHES,
 * its early return is skipped and the encode pays the per-code-unit pairing scan — the
 * distinction `execution/order-by-text-unicode-10k` exists to price at the comparator
 * level, priced here at the key level.
 *
 * A SUPERSET of the plain fixture on purpose, so `data-key-text-astral` minus
 * `data-key-text-binary` is attributable. It is NOT a controlled A/B on the surrogate scan
 * alone: the astral string is 8 UTF-16 code units and 16 UTF-8 bytes longer, so the delta is
 * the scan plus that extra text. Two strings cannot match in both code units and UTF-8 bytes
 * while one is astral and the other is not; naming which way this one differs beats implying
 * a cleanliness it does not have.
 */
const ASTRAL_TEXTS = TEXTS.map((text) => `${text}\u{1D400}\u{1D401}\u{1F4E6}\u{1F680}`);

/** Integers spanning small, large and negative — the numeric encoder is fixed-width, so
 *  magnitude should NOT move the number; a shape here that does is the finding. */
const INTEGERS = Array.from({ length: DISTINCT_ROWS }, (_, i) =>
	(i % 3 === 0 ? BigInt(i) : i % 3 === 1 ? BigInt(i) * 1_000_000_007n : -BigInt(i) * 4_294_967_296n));

/**
 * Blob fixtures, each the same 34 bytes long as a {@link TEXTS} entry is, and each carrying
 * an embedded `0x00` and `0x01` — the two bytes the shared escape scheme rewrites, so this
 * prices the escape path rather than a plain copy. (Those two escapes cost two bytes the
 * text fixture does not pay, so the pair is close but not a byte-exact A/B.)
 *
 * The BLOB path is not a curiosity: a column DECLARED `json` keys through it, because its
 * key transform maps the value to a `Uint8Array` before encoding — see `encodeObject`'s
 * comment on why the generic OBJECT path instead stays canonical text. `data-key-json`
 * prices the path an UNDECLARED `any` column holding an object takes; this prices the byte
 * shape a declared `json` column ends up in.
 */
const BLOBS = Array.from({ length: DISTINCT_ROWS }, (_, i) => {
	const bytes = new Uint8Array(34);
	for (let j = 0; j < bytes.length; j++) bytes[j] = (i * 7 + j * 13 + 2) & 0xff;
	bytes[5] = 0x00;
	bytes[6] = 0x01;
	return bytes;
});

/** @type {KeyShape[]} */
const KEY_SHAPES = [
	{
		name: 'data-key-int',
		collation: 'BINARY',
		rows: INTEGERS.map((v) => ({ values: [v] })),
	},
	{
		name: 'data-key-text-binary',
		collation: 'BINARY',
		rows: TEXTS.map((v) => ({ values: [v] })),
	},
	{
		// The same text as `data-key-text-binary`, under the collation that routes through a
		// key normalizer. The pair is the measurement: their difference IS the normalizer's
		// cost, which is why both must carry the same fixture text.
		name: 'data-key-text-nocase',
		collation: 'NOCASE',
		rows: TEXTS.map((v) => ({ values: [v], decodesTo: [v.toLowerCase()] })),
	},
	{
		name: 'data-key-text-astral',
		collation: 'BINARY',
		rows: ASTRAL_TEXTS.map((v) => ({ values: [v] })),
	},
	{
		// A plain object routes through the generic OBJECT path: canonical (recursively
		// key-sorted) JSON text, then the escaped-text encoding. `decodesTo` is written with
		// its keys ALREADY IN SORTED ORDER, because that is the order the canonical string
		// puts them in and the round-trip check compares JSON text.
		name: 'data-key-json',
		collation: 'BINARY',
		rows: Array.from({ length: DISTINCT_ROWS }, (_, i) => {
			const value = { sku: `sku-${i}`, dims: [i, i + 1, i + 2], active: i % 2 === 0 };
			return { values: [value], decodesTo: [{ active: value.active, dims: value.dims, sku: value.sku }] };
		}),
	},
	{
		// Raw bytes: no UTF-8 step and no collation, but the same escape-and-terminate scheme
		// TEXT uses, so its distance from `data-key-text-binary` is roughly the UTF-8 encode.
		name: 'data-key-blob',
		collation: 'BINARY',
		rows: BLOBS.map((v) => ({ values: [v] })),
	},
	{
		// The ASC control for `data-key-desc-2col`, over the SAME fixture values. Without it a
		// DESC number is uninterpretable — nothing else in the table encodes these two columns,
		// so there would be nothing to subtract the inversion from.
		name: 'data-key-asc-2col',
		collation: 'BINARY',
		rows: INTEGERS.map((v, i) => ({ values: [v, TEXTS[i]] })),
	},
	{
		// Both columns DESC. The encoder XORs every byte of each column's encoding in place —
		// on buffers it allocated itself, so this is safe, but it does mean a caller cannot
		// pre-encode and reuse a buffer across calls.
		name: 'data-key-desc-2col',
		collation: 'BINARY',
		descending: true,
		rows: INTEGERS.map((v, i) => ({ values: [v, TEXTS[i]] })),
	},
	{
		// The realistic composite: an integer, text, a non-integer real and a NULL member.
		name: 'data-key-composite-4col',
		collation: 'BINARY',
		rows: INTEGERS.map((v, i) => ({ values: [v, TEXTS[i], i + 0.5, null] })),
	},
];

/**
 * Cycle `rows` up to {@link KEYS_PER_CALL} entries.
 *
 * Built in `setup`, never in `fn`: calibration times several consecutive `fn` calls as one
 * sample for sub-millisecond work, so an `fn` that allocated its own inputs would be
 * reporting the allocation alongside the encode.
 *
 * @param {FixtureRow[]} rows
 * @returns {import('@quereus/quereus').SqlValue[][]}
 */
function cycleRows(rows) {
	return Array.from({ length: KEYS_PER_CALL }, (_, i) => rows[i % rows.length].values);
}

/**
 * The `directions` argument for a shape: all-DESC or nothing. See {@link KeyShape.descending}.
 *
 * One definition, used by both the timed body and the round-trip check, so the key those two
 * look at cannot diverge — a round trip that verified an ASC key while `fn` timed a DESC one
 * would be verifying nothing.
 *
 * @param {boolean|undefined} descending
 * @param {number} columnCount
 * @returns {boolean[]|undefined}
 */
function directionsFor(descending, columnCount) {
	return descending ? Array.from({ length: columnCount }, () => true) : undefined;
}

/**
 * Whether two decoded values are the same value.
 *
 * Deliberately cheap — `===` after a type dispatch — because the decode benchmark runs this
 * inside its TIMED body and a stringify-and-compare there would swamp the decode it is
 * measuring. Objects and blobs are compared structurally; only `setup` ever hits those paths.
 *
 * @param {import('@quereus/quereus').SqlValue} a
 * @param {import('@quereus/quereus').SqlValue} b
 * @returns {boolean}
 */
function sameValue(a, b) {
	if (a === null || b === null) return a === b;
	if (a instanceof Uint8Array || b instanceof Uint8Array) {
		if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (a[i] !== b[i]) return false;
		}
		return true;
	}
	if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
	return a === b;
}

/**
 * A readable rendering of a decoded value, for a round-trip failure message. Distinguishes
 * the numeric classes, because "expected 5, got 5" is what a naive message prints when a
 * `number` decoded to a `bigint`.
 *
 * @param {import('@quereus/quereus').SqlValue} value
 * @returns {string}
 */
function describeValue(value) {
	if (value === null) return 'null';
	if (typeof value === 'bigint') return `bigint(${value})`;
	if (typeof value === 'number') return `number(${value})`;
	if (typeof value === 'string') return `text(${JSON.stringify(value)})`;
	if (value instanceof Uint8Array) return `blob(${value.length} bytes)`;
	return `json(${JSON.stringify(value)})`;
}

/**
 * Throw unless every distinct fixture row survives an encode/decode round trip.
 *
 * THIS is the assertion that stops the suite from measuring a broken encoder, and it belongs
 * in `setup` because it is untimed and therefore free. A decode inside an encode benchmark's
 * timed body would cost about as much as the encode itself and halve the resolution of the
 * very thing being measured — so `fn` asserts only the total byte length (see
 * {@link makeKeyBenchmark}), which is cheap and still catches an encoder that stopped
 * producing bytes.
 *
 * @param {string} name benchmark name, for the failure message
 * @param {FixtureRow[]} rows
 * @param {import('../lib/store-counters.mjs').StoreKeyApi} api
 * @param {import('@quereus/store').EncodeOptions} options
 * @param {boolean} descending
 */
function assertRoundTrip(name, rows, api, options, descending) {
	for (const row of rows) {
		const directions = directionsFor(descending, row.values.length);
		const key = api.encodeCompositeKey(row.values, options, directions);
		// `decodeCompositeKey` takes no `directions`, so a DESC key must be un-inverted first.
		// Every column is inverted or none is (see `KeyShape.descending`), so XORing the whole
		// buffer is exact — no need to know where one column's bytes end and the next begin.
		let decodable = key;
		if (descending) {
			decodable = new Uint8Array(key.length);
			for (let i = 0; i < key.length; i++) decodable[i] = key[i] ^ 0xff;
		}
		const decoded = api.decodeCompositeKey(decodable, undefined, options);
		const expected = row.decodesTo ?? row.values;
		if (decoded.length !== expected.length) {
			throw new Error(`${name}: round trip returned ${decoded.length} values, expected ${expected.length}`);
		}
		for (let i = 0; i < expected.length; i++) {
			if (!sameValue(decoded[i], expected[i])) {
				throw new Error(`${name}: round trip of column ${i} gave ${describeValue(decoded[i])}, expected ${describeValue(expected[i])}`);
			}
		}
	}
}

/**
 * Build one key-encoding benchmark from a shape.
 *
 * @param {KeyShape} shape
 * @returns {import('../lib/discover.mjs').Benchmark}
 */
function makeKeyBenchmark(shape) {
	/** @type {import('../lib/store-counters.mjs').StoreKeyApi|null} */
	let api = null;
	/** @type {import('@quereus/quereus').SqlValue[][]} */
	let rows = [];
	/** @type {import('@quereus/store').EncodeOptions} */
	let options = {};
	/** @type {boolean[]|undefined} */
	let directions;
	let expectedBytes = 0;

	return {
		name: shape.name,
		skip: skipUnlessStoreLoads,
		async setup() {
			api = await loadStoreKeyApi();
			// The resolver is named explicitly rather than left to the default so the row says
			// which normalizers it prices. It is also what the default resolves to, so this
			// changes no number today.
			//
			// NOTE: production encode sites that hold a `Database` pass
			// `db.getKeyNormalizerResolver()` instead, which consults the collation registry
			// and can see a `registerCollation`-supplied normalizer. If the two resolvers ever
			// diverge in cost, this suite is measuring the cheaper one; add a second NOCASE row
			// over a `Database` resolver rather than swapping this one.
			options = { collation: shape.collation, normalizers: api.BUILTIN_KEY_NORMALIZER_RESOLVER };
			assertRoundTrip(shape.name, shape.rows, api, options, shape.descending === true);
			rows = cycleRows(shape.rows);
			directions = directionsFor(shape.descending, shape.rows[0].values.length);
			expectedBytes = 0;
			for (const values of rows) {
				expectedBytes += api.buildDataKey(values, options, directions).length;
			}
		},
		teardown() {
			api = null;
			rows = [];
		},
		fn() {
			const build = /** @type {import('../lib/store-counters.mjs').StoreKeyApi} */ (api).buildDataKey;
			let bytes = 0;
			for (let i = 0; i < KEYS_PER_CALL; i++) {
				bytes += build(rows[i], options, directions).length;
			}
			if (bytes !== expectedBytes) {
				throw new Error(`${shape.name}: built ${bytes} key bytes, expected ${expectedBytes}`);
			}
		},
	};
}

/**
 * A secondary-index key: the index columns, then the primary key.
 *
 * Kept separate from the shape table because `buildIndexKey` takes two half-descriptors
 * rather than one value list, and it is the shape that actually runs once per row per index
 * on every write — the cost this whole suite exists to make visible.
 *
 * @returns {import('../lib/discover.mjs').Benchmark}
 */
function makeIndexKeyBenchmark() {
	const name = 'index-key-text-int';
	/** @type {import('../lib/store-counters.mjs').StoreKeyApi|null} */
	let api = null;
	/** @type {{index: {values: import('@quereus/quereus').SqlValue[]}, pk: {values: import('@quereus/quereus').SqlValue[]}}[]} */
	let halves = [];
	/** @type {import('@quereus/store').EncodeOptions} */
	let options = {};
	let expectedBytes = 0;

	return {
		name,
		skip: skipUnlessStoreLoads,
		async setup() {
			api = await loadStoreKeyApi();
			options = { collation: 'BINARY', normalizers: api.BUILTIN_KEY_NORMALIZER_RESOLVER };
			// An index key is the two halves' encodings concatenated, and each half is a
			// composite key of self-delimiting per-column encodings — so decoding the whole
			// thing yields the index columns followed by the PK columns, in order.
			const distinct = TEXTS.map((text, i) => ({
				values: [text, INTEGERS[i]],
				decodesTo: [text, INTEGERS[i]],
			}));
			assertRoundTrip(name, distinct, api, options, false);
			halves = Array.from({ length: KEYS_PER_CALL }, (_, i) => {
				const row = distinct[i % distinct.length];
				return { index: { values: [row.values[0]] }, pk: { values: [row.values[1]] } };
			});
			expectedBytes = 0;
			for (const half of halves) {
				expectedBytes += api.buildIndexKey(half.index, half.pk, options).length;
			}
		},
		teardown() {
			api = null;
			halves = [];
		},
		fn() {
			const build = /** @type {import('../lib/store-counters.mjs').StoreKeyApi} */ (api).buildIndexKey;
			let bytes = 0;
			for (let i = 0; i < KEYS_PER_CALL; i++) {
				const half = halves[i];
				bytes += build(half.index, half.pk, options).length;
			}
			if (bytes !== expectedBytes) {
				throw new Error(`${name}: built ${bytes} index-key bytes, expected ${expectedBytes}`);
			}
		},
	};
}

/**
 * The decode side, priced once.
 *
 * Every encode benchmark above deliberately keeps decode OUT of its timed body, so without
 * this row the decode path would carry no number at all — a lost fast path there would show
 * up only as a slower full scan, which is the diagnosis problem this suite exists to fix.
 *
 * Here the decode IS the subject, so `fn` asserts VALUE EQUALITY on every decoded column
 * rather than a byte length. The fixture is the 4-column composite, all scalar members, so
 * the check is a typed `===` per value — small against a decode that allocates and runs a
 * `TextDecoder`.
 *
 * @returns {import('../lib/discover.mjs').Benchmark}
 */
function makeDecodeBenchmark() {
	const name = 'decode-composite-4col';
	const shape = /** @type {KeyShape} */ (KEY_SHAPES.find((s) => s.name === 'data-key-composite-4col'));
	/** @type {import('../lib/store-counters.mjs').StoreKeyApi|null} */
	let api = null;
	/** @type {Uint8Array[]} */
	let keys = [];
	/** @type {import('@quereus/quereus').SqlValue[][]} */
	let expected = [];
	/** @type {import('@quereus/store').EncodeOptions} */
	let options = {};
	let columnCount = 0;

	return {
		name,
		skip: skipUnlessStoreLoads,
		async setup() {
			api = await loadStoreKeyApi();
			options = { collation: shape.collation, normalizers: api.BUILTIN_KEY_NORMALIZER_RESOLVER };
			assertRoundTrip(name, shape.rows, api, options, false);
			columnCount = shape.rows[0].values.length;
			keys = Array.from({ length: KEYS_PER_CALL }, (_, i) =>
				/** @type {import('../lib/store-counters.mjs').StoreKeyApi} */ (api)
					.buildDataKey(shape.rows[i % shape.rows.length].values, options));
			expected = Array.from({ length: KEYS_PER_CALL }, (_, i) => {
				const row = shape.rows[i % shape.rows.length];
				return row.decodesTo ?? row.values;
			});
		},
		teardown() {
			api = null;
			keys = [];
			expected = [];
		},
		fn() {
			const decode = /** @type {import('../lib/store-counters.mjs').StoreKeyApi} */ (api).decodeCompositeKey;
			for (let i = 0; i < KEYS_PER_CALL; i++) {
				const decoded = decode(keys[i], columnCount, options);
				const want = expected[i];
				if (decoded.length !== columnCount) {
					throw new Error(`${name}: decoded ${decoded.length} values, expected ${columnCount}`);
				}
				for (let c = 0; c < columnCount; c++) {
					if (!sameValue(decoded[c], want[c])) {
						throw new Error(`${name}: column ${c} decoded to ${describeValue(decoded[c])}, expected ${describeValue(want[c])}`);
					}
				}
			}
		},
	};
}

export const benchmarks = [
	...KEY_SHAPES.map(makeKeyBenchmark),
	makeIndexKeyBenchmark(),
	makeDecodeBenchmark(),
];
