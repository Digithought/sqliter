/**
 * The storage layer, priced piece by piece.
 *
 * `execution` and `mutation` measure whole queries against a storage backend. That is the
 * right top-level signal and a poor diagnostic: a full scan blends key decoding, iteration,
 * row deserialization and the isolation overlay into one number, so a regression in any one
 * of them reads as "the scan got slower". This suite gives the store's pieces their own
 * numbers, in two halves:
 *
 *  - KEY ENCODING (`data-key-*`, `index-key-*`, `decode-*`): pure functions of their
 *    inputs — no `Database`, no provider, no statement — the cheapest pieces to measure
 *    directly. These declare NO `counters()` pass, for the same reason `parser` declares
 *    none: nothing runs, so there is nothing for a work counter to count. The absence is
 *    the honest report, not an oversight.
 *  - STORE HOT PATHS (`scan-10k` and everything after it): scanning, point reads,
 *    multi-key seeks, resolving rows found through a secondary index, committing a batch
 *    of writes, building an index, reopening a database. These run per row, per index,
 *    per commit — where a per-operation cost that should have been per-batch can hide
 *    behind a whole-query number — and none of them can be reached without white-boxing
 *    the store. So they are driven through a `Database` over the store module and
 *    reported in STORAGE ROUND TRIPS as well as time, which is the honest measurement
 *    anyway: round-trip counts are exact integers, identical on every machine, where a
 *    wall-clock median describes one CPU.
 *
 * A STORE-ONLY SUITE, SO ITS NAMES CARRY NO `@` SUFFIX. `execution` and `mutation` hold
 * workloads that `bench/lib/backends.mjs` expands across every backend, and the bare name
 * in those suites means "the engine's default vtab module". Here there is no storage
 * engine to swap underneath: the first half calls `@quereus/store` functions directly,
 * and the second half exists to measure THE store module specifically — the same query
 * shapes on the memory vtab are `execution`'s bare rows, not a missing backend of these.
 * The invariant `docs/benchmarking.md` states — every entry of BOTH those suites is
 * expanded — is untouched; this is a third suite that is not in the backend dimension at
 * all.
 *
 * TIMED AND COUNTED DATABASES ARE SEPARATE. A hot-path row's `fn` runs against
 * `openStoreDatabase()`, with no counting wrapper anywhere in it; its `counters()` pass
 * builds a SECOND database from `openCountingStoreDatabase()`, replays the fixture,
 * resets the counters at the fixture/measurement boundary, and ASSERTS the exact
 * expected round-trip block before reporting it — a plan change that moved traffic
 * between stores fails the pass loudly instead of shipping a silently different block.
 * Expected counts are derived from the imported `ROW_RESOLUTION_BATCH`, never from a
 * restated `256`, so they move with the constant.
 *
 * REACHING THE STORE PACKAGE. Through `bench/lib/store-counters.mjs` and nothing else. That
 * file's header says why: the parent process imports every suite file purely to enumerate
 * benchmark names, so a second import site is a second way for an unbuilt
 * `packages/quereus-store/dist` to kill the whole `yarn bench` run — parser and planner
 * included. `skipUnlessStoreLoads` below turns that same failure into a stated reason per
 * row, on every benchmark in the suite.
 *
 * PUBLIC EXPORTS ONLY. The key half binds `buildDataKey`, `buildIndexKey`,
 * `encodeCompositeKey`, `decodeCompositeKey` and `BUILTIN_KEY_NORMALIZER_RESOLVER`; the
 * hot-path half reaches `StoreModule` (`whenCatalogPersisted`, `rehydrateCatalog`) and the
 * key-value provider through the handles `store-counters.mjs` builds. All of it is
 * `@quereus/store`'s public surface (`packages/quereus-store/src/common/index.ts`), so this
 * suite breaks at a deliberate API change rather than at an internal refactor.
 */

import { snapshotStatement, snapshotStatements } from '../lib/counters.mjs';
import { loadStoreKeyApi, openCountingStoreDatabase, openStoreDatabase, storeLoadFailure } from '../lib/store-counters.mjs';

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

/* ═══════════════════════════════════════════════════════════════════════════════════════
 * Second half: store hot paths, driven through a `Database` over the store module.
 * See the file header for why these live here and how the timed and counted databases
 * are kept apart.
 * ═══════════════════════════════════════════════════════════════════════════════════════ */

/** Collect an async iterable into an array. */
async function collect(iter) {
	const out = [];
	for await (const item of iter) out.push(item);
	return out;
}

/**
 * Built store names of the shared `bench_t` fixture — what the key-value provider (and
 * therefore a counter block) is keyed by. An index store's name embeds both its table and
 * its index: `{schema}.{table}_idx_{index}`.
 */
const BENCH_T_DATA_STORE = 'main.bench_t';
const BENCH_T_INDEX_STORE = 'main.bench_t_idx_bench_t_val';

/** Rows per `insert ... values` statement in the fixtures below — the same batching
 * `bench/workloads/execution.mjs` uses. */
const FIXTURE_BATCH_ROWS = 500;

/**
 * Create and populate `table (id integer primary key, val integer)` with ids `0..rows-1`
 * and `val = id` — so `id < N` selects exactly N rows and a `val` range of width n
 * matches exactly n rows, which is what lets every expected count below be stated as an
 * exact integer.
 *
 * @param {import('../../dist/src/index.js').Database} db
 * @param {string} table
 * @param {number} rows
 * @param {boolean} withValIndex also `create index {table}_val on {table} (val)`
 */
async function populateIdValTable(db, table, rows, withValIndex) {
	await db.exec(`create table ${table} (id integer primary key, val integer)`);
	if (withValIndex) {
		await db.exec(`create index ${table}_val on ${table} (val)`);
	}
	for (let start = 0; start < rows; start += FIXTURE_BATCH_ROWS) {
		const count = Math.min(FIXTURE_BATCH_ROWS, rows - start);
		const values = Array.from({ length: count }, (_, j) => `(${start + j}, ${start + j})`).join(', ');
		await db.exec(`insert into ${table} values ${values}`);
	}
}

/** The shared fixture of every query-shaped row below: 10 000 rows in `bench_t`, with a
 * secondary index on `val`.
 * @param {import('../../dist/src/index.js').Database} db */
function populateBenchT(db) {
	return populateIdValTable(db, 'bench_t', 10000, true);
}

/**
 * A store expected to be OPENED but never TOUCHED: all eight counts zero. Stated in full
 * rather than left absent, because "the index store saw no traffic" is exactly the claim
 * a scan or a PK seek makes and an unasserted zero is not a claim at all.
 */
const NO_TRAFFIC = Object.freeze({
	iterateEntries: 0, getManyCalls: 0, getManyKeys: 0, singleGets: 0,
	directPuts: 0, directDeletes: 0, batchWrites: 0, batchOps: 0,
});

/**
 * Throw unless every STATED field of every stated store matches `actual` exactly.
 *
 * Only stated fields are compared, which is what lets the commit rows assert the
 * flat-batch claim without also pinning the reads a commit provokes (linear in N by
 * nature), and lets every row leave the `__stats__` / `__catalog__` zero-blocks out of
 * its contract.
 *
 * @param {string} name benchmark name, for the failure message
 * @param {Record<string, import('../lib/store-counters.mjs').StoreCounters>} actual
 * @param {Record<string, Partial<import('../lib/store-counters.mjs').StoreCounters>>} expected
 */
function assertStoreCounters(name, actual, expected) {
	for (const [storeName, fields] of Object.entries(expected)) {
		const block = actual[storeName];
		if (!block) {
			throw new Error(`${name}: counter block has no store '${storeName}' (stores present: ${Object.keys(actual).join(', ') || 'none'})`);
		}
		for (const [field, want] of Object.entries(fields)) {
			if (block[/** @type {keyof typeof block} */ (field)] !== want) {
				throw new Error(`${name}: ${storeName}.${field} is ${block[/** @type {keyof typeof block} */ (field)]}, expected ${want}`);
			}
		}
	}
}

/**
 * What one counted read-query benchmark measures, computed ONCE in `setup` — from the
 * imported `ROW_RESOLUTION_BATCH` where a count depends on it — and then driving both the
 * timed `fn` and the `counters()` pass, so the counters can never describe a different
 * statement than the one timed.
 *
 * @typedef {object} CountedQuerySpec
 * @property {string} sql the ONE statement `fn` times and `counters()` snapshots
 * @property {number} expectedRows asserted by `fn` on every call
 * @property {Record<string, Partial<import('../lib/store-counters.mjs').StoreCounters>>} expectedStore
 *   expected storage round trips by built store name; every stated field is asserted
 *   exactly (see {@link assertStoreCounters})
 */

/**
 * Build one read-query benchmark over the shared `bench_t` fixture.
 *
 * @param {string} name
 * @param {(batch: number) => CountedQuerySpec} build handed `ROW_RESOLUTION_BATCH`
 * @returns {import('../lib/discover.mjs').Benchmark}
 */
function makeCountedQueryBenchmark(name, build) {
	/** @type {import('../lib/store-counters.mjs').PlainStoreDatabaseHandle|null} */
	let handle = null;
	/** @type {CountedQuerySpec|null} */
	let spec = null;

	return {
		name,
		skip: skipUnlessStoreLoads,
		async setup() {
			const api = await loadStoreKeyApi();
			spec = build(api.ROW_RESOLUTION_BATCH);
			handle = await openStoreDatabase();
			await populateBenchT(handle.db);
		},
		// Guarded: `teardown` also runs as best-effort cleanup after a `setup` that threw,
		// and `build` throwing (a size guard) leaves no handle to close.
		async teardown() {
			if (handle) await handle.close();
			handle = null;
			spec = null;
		},
		async fn() {
			const { sql, expectedRows } = /** @type {CountedQuerySpec} */ (spec);
			const rows = await collect(/** @type {import('../lib/store-counters.mjs').PlainStoreDatabaseHandle} */ (handle).db.eval(sql));
			if (rows.length !== expectedRows) {
				throw new Error(`${name}: expected ${expectedRows} rows, got ${rows.length}`);
			}
		},
		// Runs ONCE after timing, against a second database over a counting provider —
		// fixture, then reset, then the statement, exactly the boundary discipline
		// `execution.bench.mjs`'s binder uses.
		async counters() {
			const { sql, expectedStore } = /** @type {CountedQuerySpec} */ (spec);
			const counting = await openCountingStoreDatabase();
			try {
				await populateBenchT(counting.db);
				counting.resetCounters();
				const engine = await snapshotStatement(counting.db, sql);
				const store = counting.readCounters();
				assertStoreCounters(name, store, expectedStore);
				return { engine, store };
			} finally {
				await counting.close();
			}
		},
	};
}

/**
 * One index-resolve benchmark: a `val` range of width n, sized as a multiple of
 * `ROW_RESOLUTION_BATCH` (B). The index scan yields n entries; resolving them to data
 * rows must go back to the data store in `ceil(n / B)` batched reads carrying n keys —
 * the round-trip claim this family exists to pin. If resolution ever stopped batching,
 * `getManyCalls` goes to n and the counters pass fails loudly.
 *
 * @param {string} name
 * @param {number} batchMultiple range width as a multiple of B (0.25, 1, 2, 4)
 * @returns {import('../lib/discover.mjs').Benchmark}
 */
function makeIndexResolveBenchmark(name, batchMultiple) {
	return makeCountedQueryBenchmark(name, (batch) => {
		const n = Math.max(1, Math.floor(batch * batchMultiple));
		if (2000 + n > 10000) {
			// Thrown from `setup` (where `build` runs): the range must stay inside the
			// 10 000-row fixture, or `expectedRows` silently stops meaning "range width".
			throw new Error(`${name}: range width ${n} overruns the 10 000-row fixture — ROW_RESOLUTION_BATCH grew; resize the fixture or the multiples`);
		}
		return {
			sql: `select id from bench_t where val >= 2000 and val < ${2000 + n}`,
			expectedRows: n,
			expectedStore: {
				// n entries pulled from the index, then the batched resolution against the
				// data store. Zero data iterates: resolution must be `getMany`, not a scan.
				[BENCH_T_INDEX_STORE]: { ...NO_TRAFFIC, iterateEntries: n },
				[BENCH_T_DATA_STORE]: { ...NO_TRAFFIC, getManyCalls: Math.ceil(n / batch), getManyKeys: n },
			},
		};
	});
}

/** The two values a commit benchmark's update alternates between, so every timed call
 * genuinely changes the N rows it touches. The store does NOT short-circuit a same-value
 * update (verified in code and by repeat-commit counter probes), so this is cheap
 * insurance, not a correctness requirement. */
const FLIP_A = 111;
const FLIP_B = 222;

/**
 * One commit benchmark: `begin; update N rows; commit;`, timed as a unit.
 *
 * The four sizes (1, 10, 100, 1000) together carry the claim no read count can:
 * committing N queued operations costs a number of write-side round trips that is FLAT
 * in N — `batchWrites` stays at ONE per touched store (the counting provider has no
 * `beginAtomicBatch`, so the coordinator takes its per-store fallback), while `batchOps`
 * scales as N on the data store and 2N on the index (delete the old entry, insert the
 * new one). N = 10000 was considered and deliberately dropped: the shape is visible
 * across three decades, and the fourth would add hundreds of milliseconds per timed call
 * for no additional claim.
 *
 * @param {number} rowsTouched the N in `where id < N`
 * @returns {import('../lib/discover.mjs').Benchmark}
 */
function makeCommitBenchmark(rowsTouched) {
	const name = `commit-update-${rowsTouched}`;
	/** @type {import('../lib/store-counters.mjs').PlainStoreDatabaseHandle|null} */
	let handle = null;
	let useA = true;

	/** @param {number} constant */
	const updateSql = (constant) => `update bench_t set val = ${constant} where id < ${rowsTouched}`;

	return {
		name,
		skip: skipUnlessStoreLoads,
		async setup() {
			handle = await openStoreDatabase();
			await populateBenchT(handle.db);
			useA = true;
		},
		async teardown() {
			if (handle) await handle.close();
			handle = null;
		},
		async fn() {
			const db = /** @type {import('../lib/store-counters.mjs').PlainStoreDatabaseHandle} */ (handle).db;
			const constant = useA ? FLIP_A : FLIP_B;
			useA = !useA;
			await db.exec(`begin; ${updateSql(constant)}; commit;`);
			// The point read is IN the timed number — one extra single-key get on top of the
			// commit, which matters most at N=1. Accepted: it is what stops this benchmark
			// from timing a commit that stopped writing. Compared through `Number()` because
			// an integer read back may arrive as a bigint.
			const rows = await collect(db.eval('select val from bench_t where id = 0'));
			if (rows.length !== 1 || Number(rows[0].val) !== constant) {
				throw new Error(`${name}: expected val ${constant} on row 0 after commit, got ${rows.length === 1 ? String(rows[0].val) : `${rows.length} rows`}`);
			}
		},
		async counters() {
			const counting = await openCountingStoreDatabase();
			try {
				await populateBenchT(counting.db);
				counting.resetCounters();
				// Three NAMED snapshots: instruction keys are structural addresses within one
				// program, so the three statements' engine counts must never be summed.
				const engine = await snapshotStatements(counting.db, {
					begin: 'begin',
					update: updateSql(FLIP_A),
					commit: 'commit',
				});
				const store = counting.readCounters();
				assertStoreCounters(name, store, {
					// THE flat-commit claim, plus "no write escapes the batch". Commits also
					// PROVOKE reads (read-modify-write on the data store, old-entry lookups for
					// index maintenance) — those scale with N by nature, so they are reported
					// for diffing but deliberately not asserted.
					[BENCH_T_DATA_STORE]: { batchWrites: 1, batchOps: rowsTouched, directPuts: 0, directDeletes: 0 },
					[BENCH_T_INDEX_STORE]: { batchWrites: 1, batchOps: 2 * rowsTouched, directPuts: 0, directDeletes: 0 },
				});
				return { engine, store };
			} finally {
				await counting.close();
			}
		},
	};
}

/**
 * Count the physical entries in an index store by draining its `iterate()`.
 *
 * @param {import('@quereus/store').KVStoreProvider} provider
 * @param {string} schemaName
 * @param {string} tableName
 * @param {string} indexName
 * @returns {Promise<number>}
 */
async function countIndexEntries(provider, schemaName, tableName, indexName) {
	const store = await provider.getIndexStore(schemaName, tableName, indexName);
	let count = 0;
	for await (const _entry of store.iterate()) count++;
	return count;
}

/**
 * Index build: `create index` over a 5 000-row table, then `drop index` so `fn` is
 * repeatable back-to-back. The timed number therefore covers one build, one drop, and
 * two entry-counting scans of the index store — stated so nobody reads it as the build
 * alone. The before-count doubles as the erase tripwire: a provider whose index drop
 * only discarded the handle (instead of erasing the store) reads 5 000 here on the
 * second call and fails.
 *
 * @returns {import('../lib/discover.mjs').Benchmark}
 */
function makeIndexBuildBenchmark() {
	const name = 'index-build-5k';
	const ROWS = 5000;
	/** @type {import('../lib/store-counters.mjs').PlainStoreDatabaseHandle|null} */
	let handle = null;

	return {
		name,
		skip: skipUnlessStoreLoads,
		async setup() {
			handle = await openStoreDatabase();
			await populateIdValTable(handle.db, 'bench_i', ROWS, false);
		},
		async teardown() {
			if (handle) await handle.close();
			handle = null;
		},
		async fn() {
			const h = /** @type {import('../lib/store-counters.mjs').PlainStoreDatabaseHandle} */ (handle);
			// `getIndexStore` before the index exists lazily creates an empty store — fine,
			// and exactly what makes the zero-count a real claim rather than a missing-store
			// error.
			const before = await countIndexEntries(h.provider, 'main', 'bench_i', 'bench_i_val');
			if (before !== 0) {
				throw new Error(`${name}: index store holds ${before} entries before the build — the previous drop did not erase it`);
			}
			await h.db.exec('create index bench_i_val on bench_i (val)');
			const after = await countIndexEntries(h.provider, 'main', 'bench_i', 'bench_i_val');
			if (after !== ROWS) {
				throw new Error(`${name}: index store holds ${after} entries after the build, expected ${ROWS}`);
			}
			await h.db.exec('drop index bench_i_val');
		},
		async counters() {
			const counting = await openCountingStoreDatabase();
			try {
				await populateIdValTable(counting.db, 'bench_i', ROWS, false);
				counting.resetCounters();
				// Plain `exec`, one `create index`, and NO drop: the counting provider
				// implements no index-store erase, so a drop-and-recreate cycle here would
				// read stale entries back. One build is the whole measurement.
				await counting.db.exec('create index bench_i_val on bench_i (val)');
				// Counters FIRST: the verification scan below reads through the same counting
				// store and would otherwise pollute the very block it verifies.
				const store = counting.readCounters();
				const entries = await countIndexEntries(counting.provider, 'main', 'bench_i', 'bench_i_val');
				if (entries !== ROWS) {
					throw new Error(`${name}: counting index store holds ${entries} entries after the build, expected ${ROWS}`);
				}
				return { store };
			} finally {
				await counting.close();
			}
		},
	};
}

/** Catalog fixture scale — a plain-SQL copy of `bench/apply-schema-unchanged.mjs`'s
 * generator shape, so the two harnesses describe the same catalog. 54 tables of 8
 * columns (plus a check constraint, and a foreign key to the previous table from t > 0),
 * an index on every sixth table, and 14 views each joining adjacent tables. */
const CATALOG_TABLES = 54;
const CATALOG_VIEWS = 14;
const CATALOG_INDEX_EVERY = 6;
const CATALOG_INDEXES = Math.ceil(CATALOG_TABLES / CATALOG_INDEX_EVERY);

/**
 * Build the catalog fixture on `db`. Each table gets one row because catalog persistence
 * is lazy — a table nothing ever wrote may never reach the persisted catalog at all.
 *
 * @param {import('../../dist/src/index.js').Database} db
 */
async function buildCatalogFixture(db) {
	for (let t = 0; t < CATALOG_TABLES; t++) {
		const cols = [
			'id integer primary key',
			'name text not null',
			'email text',
			'qty integer not null default 0',
			'price real default 1.5',
			'note text collate nocase',
			'active integer not null default 1',
			'created text',
		];
		const constraints = [`constraint ck_${t}_qty check (qty >= 0)`];
		if (t > 0) {
			cols.push('parent_id integer');
			constraints.push(`constraint fk_${t}_parent foreign key (parent_id) references tbl_${t - 1}(id)`);
		}
		await db.exec(`create table tbl_${t} (${[...cols, ...constraints].join(', ')})`);
		if (t % CATALOG_INDEX_EVERY === 0) {
			await db.exec(`create index idx_tbl_${t}_name on tbl_${t} (name)`);
		}
		await db.exec(`insert into tbl_${t} (id, name) values (1, 'n')`);
	}
	for (let v = 0; v < CATALOG_VIEWS; v++) {
		await db.exec(`create view vw_${v} as select a.id, a.name, b.qty from tbl_${v} a join tbl_${v + 1} b on b.parent_id = a.id where a.active = 1 and b.qty > 0`);
	}
}

/**
 * Throw unless `result` rehydrated exactly the fixture {@link buildCatalogFixture} built.
 *
 * @param {string} name benchmark name, for the failure message
 * @param {import('@quereus/store').RehydrationResult} result
 */
function assertRehydration(name, result) {
	if (result.errors.length !== 0) {
		throw new Error(`${name}: rehydration reported ${result.errors.length} error(s); first: ${result.errors[0].error.message}`);
	}
	if (result.tables.length !== CATALOG_TABLES || result.indexes.length !== CATALOG_INDEXES || result.views.length !== CATALOG_VIEWS) {
		throw new Error(`${name}: rehydrated ${result.tables.length} tables / ${result.indexes.length} indexes / ${result.views.length} views, expected ${CATALOG_TABLES} / ${CATALOG_INDEXES} / ${CATALOG_VIEWS}`);
	}
}

/**
 * Catalog rehydration: what an application pays at every reopen of an existing database.
 *
 * `setup` builds the catalog once, waits for it to persist, and closes the DATABASE
 * ONLY — the module and its provider stay alive holding the persisted catalog. Each
 * timed call then opens a fresh `Database` and a fresh module over that same provider
 * and rehydrates; the fresh-everything IS the workload. Per-call modules are abandoned
 * un-closed on purpose: `closeDbOnly()` releases the database, an in-memory module holds
 * no OS handles (probe-verified — no leaked-handle exit trip), and calling `close()` on
 * one would close the SHARED provider out from under the next call. Repeatable because
 * rehydration never consumes what it reads: the clean-shutdown marker it would consume
 * is only ever written by `module.closeAll()`, which never runs on a per-call module.
 *
 * @returns {import('../lib/discover.mjs').Benchmark}
 */
function makeCatalogRehydrateBenchmark() {
	const name = `catalog-rehydrate-${CATALOG_TABLES}t`;
	/** @type {import('../lib/store-counters.mjs').PlainStoreDatabaseHandle|null} */
	let fixtureHandle = null;

	return {
		name,
		skip: skipUnlessStoreLoads,
		async setup() {
			fixtureHandle = await openStoreDatabase();
			await buildCatalogFixture(fixtureHandle.db);
			await fixtureHandle.storeModule.whenCatalogPersisted();
			await fixtureHandle.closeDbOnly();
		},
		async teardown() {
			// `close()` — not `closeDbOnly()` — on the ORIGINAL handle: its `closeAll` is
			// what finally closes the provider every timed call shared.
			if (fixtureHandle) await fixtureHandle.close();
			fixtureHandle = null;
		},
		async fn() {
			const provider = /** @type {import('../lib/store-counters.mjs').PlainStoreDatabaseHandle} */ (fixtureHandle).provider;
			const reopened = await openStoreDatabase(provider);
			try {
				const result = await reopened.storeModule.rehydrateCatalog(reopened.db);
				assertRehydration(name, result);
			} finally {
				await reopened.closeDbOnly();
			}
		},
		// The reopen-shaped counters pass runs the other way around from every other row
		// (see `openCountingStoreDatabase`'s doc): the FIXTURE is built on the counting
		// provider, and a fresh plain handle over that same provider does the counted
		// rehydration.
		async counters() {
			const counting = await openCountingStoreDatabase();
			try {
				await buildCatalogFixture(counting.db);
				await counting.storeModule.whenCatalogPersisted();
				await counting.closeDbOnly();
				counting.resetCounters();
				const reopened = await openStoreDatabase(counting.provider);
				try {
					const result = await reopened.storeModule.rehydrateCatalog(reopened.db);
					assertRehydration(name, result);
					// Read BEFORE any close — the provider clears its counted stores on close.
					const store = counting.readCounters();
					return {
						store,
						// The rehydration counts are the assertion above; reported so a changed
						// fixture shows in a diff. `__catalog__.iterateEntries` in the store
						// block is likewise reported but never hard-asserted: view entries land
						// beside table entries and index DDL rides inside its table's bundle,
						// so the raw entry count is a catalog-layout fact, not a contract.
						rehydrated: {
							tables: result.tables.length,
							indexes: result.indexes.length,
							views: result.views.length,
							materializedViews: result.materializedViews.length,
							errors: result.errors.length,
						},
					};
				} finally {
					await reopened.closeDbOnly();
				}
			} finally {
				await counting.close();
			}
		},
	};
}

/**
 * The query-shaped hot-path rows. Sizes that depend on `ROW_RESOLUTION_BATCH` (B) are
 * computed from the imported constant inside each `build`, never restated.
 */
const COUNTED_QUERY_BENCHMARKS = [
	makeCountedQueryBenchmark('scan-10k', () => ({
		sql: 'select * from bench_t',
		expectedRows: 10000,
		expectedStore: {
			// One iterate pulling every entry, and nothing else anywhere: a full scan that
			// started issuing point reads, or consulting the index, fails here.
			[BENCH_T_DATA_STORE]: { ...NO_TRAFFIC, iterateEntries: 10000 },
			[BENCH_T_INDEX_STORE]: NO_TRAFFIC,
		},
	})),
	makeCountedQueryBenchmark('point-read-pk', () => ({
		sql: 'select * from bench_t where id = 4321',
		expectedRows: 1,
		expectedStore: {
			// Exactly one single-key get. A point read that turned into a range scan
			// (iterateEntries) or a one-key batch (getManyCalls) is a lost fast path.
			[BENCH_T_DATA_STORE]: { ...NO_TRAFFIC, singleGets: 1 },
			[BENCH_T_INDEX_STORE]: NO_TRAFFIC,
		},
	})),
	makeCountedQueryBenchmark('multi-seek-pk-10', (batch) => {
		const ids = Array.from({ length: 10 }, (_, i) => i * 1000);
		return {
			sql: `select * from bench_t where id in (${ids.join(', ')})`,
			expectedRows: ids.length,
			expectedStore: {
				// Ten spread-out keys, well under one resolution batch: ONE batched read
				// carrying all ten. If seeks ever stopped batching, `getManyCalls` goes to
				// ten — or `singleGets` takes the keys — and this fails.
				[BENCH_T_DATA_STORE]: { ...NO_TRAFFIC, getManyCalls: Math.ceil(ids.length / batch), getManyKeys: ids.length },
				[BENCH_T_INDEX_STORE]: NO_TRAFFIC,
			},
		};
	}),
	makeCountedQueryBenchmark('multi-seek-pk-over-batch', (batch) => {
		// One batch plus a quarter, so the key list spans a batch boundary whatever B is.
		const k = batch + Math.ceil(batch / 4);
		if (k > 1000) {
			// Thrown from `setup`: past 1 000 keys the multi-seek plan changes shape, and
			// this row would silently measure something else.
			throw new Error(`multi-seek-pk-over-batch: k=${k} exceeds the 1000-key multi-seek cap — ROW_RESOLUTION_BATCH grew; resize the sizes here`);
		}
		const ids = Array.from({ length: k }, (_, i) => i);
		return {
			sql: `select * from bench_t where id in (${ids.join(', ')})`,
			expectedRows: k,
			expectedStore: {
				[BENCH_T_DATA_STORE]: { ...NO_TRAFFIC, getManyCalls: Math.ceil(k / batch), getManyKeys: k },
				[BENCH_T_INDEX_STORE]: NO_TRAFFIC,
			},
		};
	}),
	makeIndexResolveBenchmark('index-resolve-quarter-batch', 0.25),
	makeIndexResolveBenchmark('index-resolve-one-batch', 1),
	makeIndexResolveBenchmark('index-resolve-two-batches', 2),
	// NOTE: at 4B = 1 024 rows this is ~10% selectivity against the 10 000-row fixture —
	// the largest width probe-verified to still pick the index plan. If
	// ROW_RESOLUTION_BATCH grows, the planner may flip this row to a full scan; the
	// counter assert (index iterateEntries = n, zero data iterates) is what catches that,
	// loudly, rather than the timing quietly changing meaning.
	makeIndexResolveBenchmark('index-resolve-four-batches', 4),
];

export const benchmarks = [
	...KEY_SHAPES.map(makeKeyBenchmark),
	makeIndexKeyBenchmark(),
	makeDecodeBenchmark(),
	...COUNTED_QUERY_BENCHMARKS,
	makeCommitBenchmark(1),
	makeCommitBenchmark(10),
	makeCommitBenchmark(100),
	makeCommitBenchmark(1000),
	makeIndexBuildBenchmark(),
	makeCatalogRehydrateBenchmark(),
];
