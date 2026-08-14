/**
 * Standalone IndexedDB index-resolution benchmark arms.
 *
 * WHAT THIS MEASURES
 * ------------------
 * A secondary-index read in `@quereus/store` costs two things: fetching the index ENTRIES
 * (contiguous, cheap) and resolving each entry's scattered primary key to its ROW. Today the
 * resolution is one `IDBObjectStore.get()` per row, 256 requests pipelined into one readonly
 * transaction (`IndexedDBStore.getMany`). A real browser can do that resolution natively:
 * an `IDBIndex` over the data store returns whole record VALUES from one `index.getAll(range)`,
 * with the per-key lookups happening inside the engine instead of one JS event per row.
 *
 * This file implements both request patterns — plus three controls — as pure functions over a
 * passed-in `IDBFactory`. NOTHING here imports the plugin or the engine: it is loadable both
 * from `index.html` in a real browser and from the Node smoke test against `fake-indexeddb`.
 *
 * TIMINGS FROM `fake-indexeddb` ARE MEANINGLESS. The Node spec asserts row-set equality only.
 *
 * NOTE: this file is plain JavaScript so the page can load it with no build step, and
 * `tsconfig.test.json` pulls it in with `allowJs` but NOT `checkJs` — nothing here is
 * type-checked. That is fine while the harness stays this size and the smoke spec covers every
 * arm; if it grows real branching logic, turn `checkJs` on (or move it to TypeScript with a
 * build step) rather than trusting the spec to catch a typo in a rarely-taken path.
 *
 * DATA MODEL (replicates the store's real key shapes — see packages/quereus-store/README.md)
 * ------------------------------------------------------------------------------------------
 *   data key  = 4-byte big-endian row ordinal            (the "encoded primary key")
 *   index key = 4-byte big-endian secondary value
 *             ‖ 4-byte big-endian row ordinal            (`buildIndexKey`: index cols + PK)
 *   row value = 200 bytes: [0..4) ordinal, [4..8) secondary value, rest deterministic filler
 *
 * The PK suffix inside the index key makes every index KEY unique even though many rows share
 * a secondary VALUE — that uniqueness is what arm B's resume-edge paging stands on. Rows come
 * in runs of {@link RUN} sharing one secondary value, so a page boundary can land inside a run
 * of equal values (the case the smoke test pins).
 *
 * Two placements of the secondary key, never in the same database:
 *   two-store layout (today's design) — object stores `data` and `idx`; an `idx` record is
 *                                       key = index key bytes, value = data key bytes.
 *   native layout                     — object store `data` only; values wrapped as
 *                                       `{ v: <row bytes>, x: <index key bytes> }` with
 *                                       `createIndex('x', 'x')` (binary index keys need IDB 2).
 *
 * Both layouts use OUT-OF-LINE keys, like the real store.
 *
 * SELECTIVITY. Every row gets a distinct rank in [0, rowCount); the secondary value is
 * `floor(rank / RUN)`. The benchmark query is the range `secondary value < K`, which matches
 * exactly `K * RUN` rows. Clustering is chosen by how ranks are assigned:
 *   clustered — rank = ordinal, so matching rows are one contiguous span of primary keys.
 *   uniform   — rank = a seeded random permutation, so matching rows are a uniform random
 *               sample scattered across the whole primary-key space. Scatter is the whole
 *               problem this benchmark exists to price, so both distributions get measured.
 */

export const DATA_STORE = 'data';
export const IDX_STORE = 'idx';
export const INDEX_NAME = 'x';

/** Entries fetched per page — mirrors `BATCH` in src/store.ts. */
export const DEFAULT_PAGE = 256;
/** Rows resolved per readonly transaction — mirrors `ROW_RESOLUTION_BATCH` in @quereus/store. */
export const RESOLVE_BATCH = 256;
/** Row payload size; big enough that moving rows costs something, small enough to seed 20k fast. */
export const ROW_BYTES = 200;
/** Rows sharing one secondary value. Not a divisor of DEFAULT_PAGE's neighbours by accident —
 *  the smoke test picks page sizes that split a run to exercise the resume edge mid-run. */
export const RUN = 4;

/* ------------------------------------------------------------------ environment + primitives */

/**
 * Bind the IndexedDB globals this module needs. `IDBFactory` alone is not enough: building a
 * key range needs the `IDBKeyRange` constructor, which is a separate global.
 *
 * @param {IDBFactory} [factory]
 * @param {typeof IDBKeyRange} [keyRange]
 */
export function makeEnv(factory = globalThis.indexedDB, keyRange = globalThis.IDBKeyRange) {
	if (!factory) throw new Error('makeEnv: no IDBFactory available');
	if (!keyRange) throw new Error('makeEnv: no IDBKeyRange constructor available');
	return {
		factory,
		KeyRange: keyRange,
		/** Byte-order comparison of two IDB keys, delegated to the engine's own comparator. */
		cmp: (a, b) => factory.cmp(a, b),
		now: () => globalThis.performance.now(),
	};
}

/** Settle on an IDBRequest. */
function req(request) {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

/** Settle when a transaction commits (or aborts). */
function txDone(tx) {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
	});
}

export function openDb(env, name, version, upgrade) {
	return new Promise((resolve, reject) => {
		const request = env.factory.open(name, version);
		request.onupgradeneeded = () => upgrade(request.result, request.transaction);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
		request.onblocked = () => reject(new Error(`open blocked (another connection is holding ${name})`));
	});
}

export function deleteDb(env, name) {
	return new Promise((resolve, reject) => {
		const request = env.factory.deleteDatabase(name);
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error);
		request.onblocked = () => reject(new Error(`delete blocked (a connection is still open on ${name})`));
	});
}

/** 4-byte big-endian ArrayBuffer — byte order matches numeric order, so key order does too. */
export function encU32(n) {
	const buf = new ArrayBuffer(4);
	new DataView(buf).setUint32(0, n >>> 0);
	return buf;
}

/** Concatenate two ArrayBuffers into a new one. */
function concatBuf(a, b) {
	const out = new Uint8Array(a.byteLength + b.byteLength);
	out.set(new Uint8Array(a), 0);
	out.set(new Uint8Array(b), a.byteLength);
	return out.buffer;
}

/** Normalize whatever an engine hands back (buffer or view) to a Uint8Array view. */
function asBytes(data) {
	return ArrayBuffer.isView(data)
		? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
		: new Uint8Array(data);
}

/** Lowercase hex of a key — the set-membership token arm D filters on. */
export function hexOf(data) {
	const bytes = asBytes(data);
	let out = '';
	for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
	return out;
}

/**
 * Row identity: the ordinal stored in the row's first 4 bytes (for a value) or the whole
 * 4-byte data key (for a primary key). Every arm returns ordinals, so their results are
 * directly comparable as sets whether the arm read rows, keys, or wrapped records.
 */
export function ordinalOf(data) {
	const bytes = asBytes(data);
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
}

/** Secondary value carried inside a row's bytes — what arm C filters on without an index. */
export function secondaryOf(data) {
	const bytes = asBytes(data);
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4);
}

/* --------------------------------------------------------------------------------- dataset */

/** Deterministic 32-bit PRNG (mulberry32) — same seed, same dataset, every run and engine. */
export function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Seeded Fisher–Yates permutation of [0, n). */
function permutation(n, rand) {
	const out = new Uint32Array(n);
	for (let i = 0; i < n; i++) out[i] = i;
	for (let i = n - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		const tmp = out[i];
		out[i] = out[j];
		out[j] = tmp;
	}
	return out;
}

/** Build one row's 200-byte payload: ordinal, secondary value, then deterministic filler. */
function makeRowValue(ordinal, secondary) {
	const buf = new ArrayBuffer(ROW_BYTES);
	const view = new DataView(buf);
	view.setUint32(0, ordinal);
	view.setUint32(4, secondary);
	const bytes = new Uint8Array(buf);
	let state = (ordinal * 2654435761) >>> 0;
	for (let i = 8; i < ROW_BYTES; i++) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		bytes[i] = (state >>> 24) & 0xff;
	}
	return buf;
}

/**
 * Build the row set both layouts are seeded from.
 *
 * @param {{rowCount?: number, clustering?: 'clustered'|'uniform', seed?: number, run?: number}} [opts]
 */
export function buildDataset(opts = {}) {
	const rowCount = opts.rowCount ?? 20000;
	const clustering = opts.clustering ?? 'clustered';
	const run = opts.run ?? RUN;
	const seed = opts.seed ?? 20240613;

	const ranks = clustering === 'clustered'
		? Uint32Array.from({ length: rowCount }, (_, i) => i)
		: permutation(rowCount, mulberry32(seed));

	const rows = new Array(rowCount);
	for (let i = 0; i < rowCount; i++) {
		const secondary = Math.floor(ranks[i] / run);
		const pk = encU32(i);
		rows[i] = {
			ordinal: i,
			secondary,
			pk,
			indexKey: concatBuf(encU32(secondary), pk),
			value: makeRowValue(i, secondary),
		};
	}
	return { rowCount, run, clustering, seed, rows };
}

/**
 * Distinct secondary values a selectivity asks for. `K * run` rows match exactly, so the
 * requested fraction is honoured to the row wherever `fraction * rowCount` is a multiple
 * of `run`.
 */
export function selectivityToK(dataset, fraction) {
	const k = Math.max(1, Math.round((fraction * dataset.rowCount) / dataset.run));
	return Math.min(k, Math.ceil(dataset.rowCount / dataset.run));
}

/** Ordinals the query `secondary < K` must return — the oracle every arm is checked against. */
export function expectedOrdinals(dataset, k) {
	const out = [];
	for (const row of dataset.rows) if (row.secondary < k) out.push(row.ordinal);
	return out;
}

/**
 * Index-key bounds for `secondary < K`.
 *
 * Binary IDB keys compare byte-wise with a shorter prefix ordering FIRST, so the bare 4-byte
 * `encU32(k)` sorts below every 8-byte `encU32(k) ‖ pk`: an exclusive upper bound there drops
 * the whole `secondary == k` run without needing to know any primary key.
 */
function indexBounds(k) {
	return { low: encU32(0), high: encU32(k) };
}

/**
 * True when two bounds describe a range that can hold nothing: crossed, or a single point
 * excluded by either edge. `IDBKeyRange.bound` throws DataError on exactly these inputs, so
 * every paging loop must short-circuit rather than build one — the same guard `isEmptyRange`
 * provides in src/store.ts.
 *
 * This is reached whenever a page fills exactly to the range's last key: the exclusive resume
 * edge then equals the (inclusive or exclusive) upper bound.
 */
function isEmptyRange(env, lower, upper) {
	const c = env.cmp(lower.key, upper.key);
	return c > 0 || (c === 0 && (lower.open || upper.open));
}

/* --------------------------------------------------------------------------------- seeding */

/**
 * Seed the two-store layout, deleting any prior database first — browser disk state carries
 * over between runs, and seeding on top of it would bias both the write and the read timings.
 *
 * @returns {Promise<{db: IDBDatabase, ms: number, requests: number, transactions: number}>}
 */
export async function seedTwoStore(env, dbName, dataset, opts = {}) {
	const chunk = opts.chunk ?? 1000;
	await deleteDb(env, dbName);
	const db = await openDb(env, dbName, 1, (database) => {
		database.createObjectStore(DATA_STORE);
		database.createObjectStore(IDX_STORE);
	});
	let transactions = 0;
	const t0 = env.now();
	for (let start = 0; start < dataset.rows.length; start += chunk) {
		const tx = db.transaction([DATA_STORE, IDX_STORE], 'readwrite');
		transactions++;
		const data = tx.objectStore(DATA_STORE);
		const idx = tx.objectStore(IDX_STORE);
		for (let i = start; i < Math.min(start + chunk, dataset.rows.length); i++) {
			const row = dataset.rows[i];
			data.put(row.value, row.pk);
			idx.put(row.pk, row.indexKey);
		}
		await txDone(tx);
	}
	return { db, ms: env.now() - t0, requests: dataset.rows.length * 2, transactions };
}

/**
 * Seed the native layout: one store, records wrapped as `{v, x}`, one engine-maintained index
 * over the binary `x` property. Index maintenance is the engine's problem here — that cost
 * difference against the two-store layout is exactly what arm E prices.
 */
export async function seedNative(env, dbName, dataset, opts = {}) {
	const chunk = opts.chunk ?? 1000;
	await deleteDb(env, dbName);
	const db = await openDb(env, dbName, 1, (database) => {
		const store = database.createObjectStore(DATA_STORE);
		store.createIndex(INDEX_NAME, INDEX_NAME);
	});
	let transactions = 0;
	const t0 = env.now();
	for (let start = 0; start < dataset.rows.length; start += chunk) {
		const tx = db.transaction(DATA_STORE, 'readwrite');
		transactions++;
		const data = tx.objectStore(DATA_STORE);
		for (let i = start; i < Math.min(start + chunk, dataset.rows.length); i++) {
			const row = dataset.rows[i];
			data.put({ v: row.value, x: row.indexKey }, row.pk);
		}
		await txDone(tx);
	}
	return { db, ms: env.now() - t0, requests: dataset.rows.length, transactions };
}

/**
 * Probe whether this engine accepts a binary value at an index key path. Chromium and Firefox
 * do (IndexedDB 2); Safari needs 14+. Returns a reason string instead of throwing something
 * opaque out of the middle of a seeding run.
 *
 * @returns {Promise<{supported: boolean, reason?: string}>}
 */
export async function probeBinaryIndexKeys(env, dbName = 'quereus-bench-probe') {
	try {
		await deleteDb(env, dbName);
		const db = await openDb(env, dbName, 1, (database) => {
			database.createObjectStore(DATA_STORE).createIndex(INDEX_NAME, INDEX_NAME);
		});
		try {
			const writeTx = db.transaction(DATA_STORE, 'readwrite');
			writeTx.objectStore(DATA_STORE).put({ v: encU32(1), x: encU32(7) }, encU32(1));
			await txDone(writeTx);
			const readTx = db.transaction(DATA_STORE, 'readonly');
			const hits = await req(readTx.objectStore(DATA_STORE).index(INDEX_NAME).getAll(
				env.KeyRange.bound(encU32(0), encU32(9)),
			));
			if (hits.length !== 1) return { supported: false, reason: 'binary index range returned no record' };
			return { supported: true };
		} finally {
			db.close();
			await deleteDb(env, dbName);
		}
	} catch (error) {
		return { supported: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

/* ------------------------------------------------------------------------------ shared read */

/**
 * Page a store's `getAllKeys` + `getAll` pair, exactly as `readBatchedForward` does.
 *
 * Both requests are issued SYNCHRONOUSLY into the same transaction: an `await` between them
 * would let the readonly transaction auto-commit, and the two results could then describe
 * different states of the store and be zipped into rows under the wrong keys.
 *
 * `want` is never allowed to reach the engine non-positive — IndexedDB reads `count: 0` as
 * "every record in the range", which would silently turn a bounded page into a full read.
 */
async function readPage(store, range, want) {
	if (want <= 0) return { keys: [], values: [] };
	const keysRequest = store.getAllKeys(range, want);
	const valuesRequest = store.getAll(range, want);
	const [keys, values] = await Promise.all([req(keysRequest), req(valuesRequest)]);
	if (keys.length !== values.length) {
		throw new Error(`batched read misaligned: ${keys.length} keys vs ${values.length} values`);
	}
	return { keys, values };
}

/**
 * Producer half of arms A and D: walk the `idx` store's entries for `secondary < K` and hand
 * back the data keys they name, in index order. One `getAllKeys`+`getAll` pair per page, each
 * page in its own short-lived readonly transaction (a transaction cannot survive the await
 * between pages).
 */
async function collectIndexEntries(env, db, k, pageSize) {
	const { low, high } = indexBounds(k);
	const dataKeys = [];
	let requests = 0;
	let transactions = 0;
	let lower = { key: low, open: false };
	for (;;) {
		// An exhausted resume edge collapses the bounds to an empty range, which
		// `IDBKeyRange.bound` rejects with DataError — short-circuit instead of building one.
		if (isEmptyRange(env, lower, { key: high, open: true })) break;
		const range = env.KeyRange.bound(lower.key, high, lower.open, true);
		const tx = db.transaction(IDX_STORE, 'readonly');
		transactions++;
		requests += 2;
		const { keys, values } = await readPage(tx.objectStore(IDX_STORE), range, pageSize);
		for (const value of values) dataKeys.push(value);
		if (keys.length < pageSize) break;
		lower = { key: keys[keys.length - 1], open: true };
	}
	return { dataKeys, requests, transactions };
}

/**
 * The `KVStore.getMany` request pattern verbatim: every `get` issued synchronously into ONE
 * readonly transaction, results taken by request POSITION rather than arrival order.
 */
function resolveRowsOneTx(db, keys) {
	const tx = db.transaction(DATA_STORE, 'readonly');
	const store = tx.objectStore(DATA_STORE);
	return Promise.all(keys.map((key) => req(store.get(key))));
}

/* ------------------------------------------------------------------------------------- arms */

/**
 * Arm A — the current path. Two-store layout: page the index store, then resolve each batch of
 * up to {@link RESOLVE_BATCH} data keys with one `getMany`-shaped transaction of N point reads.
 * Resolution is interleaved with index paging, like `StoreTableScan.resolveRowBatch`.
 */
export async function armA(env, db, opts) {
	const { k } = opts;
	const pageSize = opts.pageSize ?? DEFAULT_PAGE;
	const resolveBatch = opts.resolveBatch ?? RESOLVE_BATCH;
	const { low, high } = indexBounds(k);
	const ordinals = [];
	let requests = 0;
	let transactions = 0;
	let pending = [];

	const flush = async (min) => {
		while (pending.length >= min && pending.length > 0) {
			const chunk = pending.splice(0, resolveBatch);
			transactions++;
			requests += chunk.length;
			const rows = await resolveRowsOneTx(db, chunk);
			for (const row of rows) {
				if (row === undefined) throw new Error('arm A: index entry named a missing row');
				ordinals.push(ordinalOf(row));
			}
		}
	};

	const t0 = env.now();
	let lower = { key: low, open: false };
	for (;;) {
		if (isEmptyRange(env, lower, { key: high, open: true })) break;
		const range = env.KeyRange.bound(lower.key, high, lower.open, true);
		const tx = db.transaction(IDX_STORE, 'readonly');
		transactions++;
		requests += 2;
		const { keys, values } = await readPage(tx.objectStore(IDX_STORE), range, pageSize);
		for (const value of values) pending.push(value);
		await flush(resolveBatch);
		if (keys.length < pageSize) break;
		lower = { key: keys[keys.length - 1], open: true };
	}
	await flush(1);
	return { ordinals, ms: env.now() - t0, requests, transactions };
}

/**
 * Arm B — native index. One `index.getAll(range, page)` per page returns whole records, so the
 * per-row primary-key lookups happen inside the engine.
 *
 * The resume edge is the last returned record's own `x` (the index key), which is unique
 * because `buildIndexKey` bakes the primary key into it. Without that uniqueness a page
 * boundary landing inside a run of equal secondary values would either repeat the run
 * (inclusive resume) or skip its tail (exclusive resume).
 */
export async function armB(env, db, opts) {
	const { k } = opts;
	const pageSize = opts.pageSize ?? DEFAULT_PAGE;
	const { low, high } = indexBounds(k);
	const ordinals = [];
	let requests = 0;
	let transactions = 0;

	const t0 = env.now();
	let lower = { key: low, open: false };
	for (;;) {
		if (isEmptyRange(env, lower, { key: high, open: true })) break;
		const range = env.KeyRange.bound(lower.key, high, lower.open, true);
		const tx = db.transaction(DATA_STORE, 'readonly');
		transactions++;
		requests += 1;
		const records = await req(tx.objectStore(DATA_STORE).index(INDEX_NAME).getAll(range, pageSize));
		for (const record of records) ordinals.push(ordinalOf(record.v));
		if (records.length < pageSize) break;
		lower = { key: records[records.length - 1].x, open: true };
	}
	return { ordinals, ms: env.now() - t0, requests, transactions };
}

/**
 * Arm B2 — native entries only. `index.getAllKeys` returns the matched records' PRIMARY keys
 * without reading a single row, isolating entry-fetch cost so that arm A vs arm B decomposes
 * into "entries" plus "resolution".
 *
 * Paging note: `getAllKeys` on an index hands back primary keys, not index keys, so there is no
 * resume edge to read out of the result. This arm therefore pages by carving the query's own
 * secondary-value range into fixed windows — legitimate for a CONTROL (it does the same engine
 * work in the same number of requests) but not a paging strategy a real backend could use,
 * since it depends on knowing the value distribution. It is consequently a lower bound: one
 * request per page and zero row reads.
 */
export async function armB2(env, db, opts) {
	const { k } = opts;
	const pageSize = opts.pageSize ?? DEFAULT_PAGE;
	const run = opts.run ?? RUN;
	const valuesPerPage = Math.max(1, Math.floor(pageSize / run));
	const ordinals = [];
	let requests = 0;
	let transactions = 0;

	const t0 = env.now();
	for (let lo = 0; lo < k; lo += valuesPerPage) {
		const hi = Math.min(k, lo + valuesPerPage);
		const want = (hi - lo) * run;
		const range = env.KeyRange.bound(encU32(lo), encU32(hi), false, true);
		const tx = db.transaction(DATA_STORE, 'readonly');
		transactions++;
		requests += 1;
		const keys = await req(tx.objectStore(DATA_STORE).index(INDEX_NAME).getAllKeys(range, want));
		// A window that fills its cap may have been truncated — that would silently drop rows,
		// so the window arithmetic above must always leave headroom.
		if (keys.length > want) throw new Error(`arm B2: window returned ${keys.length} > cap ${want}`);
		for (const key of keys) ordinals.push(ordinalOf(key));
	}
	return { ordinals, ms: env.now() - t0, requests, transactions };
}

/**
 * Arm C — full scan plus JS filter: the workaround baseline, and selectivity-independent by
 * construction. Pages the data store in primary-key order with the same `getAllKeys`+`getAll`
 * pair `IndexedDBStore.iterate` uses, and tests each row's embedded secondary value.
 */
export async function armC(env, db, opts) {
	const { k } = opts;
	const pageSize = opts.pageSize ?? DEFAULT_PAGE;
	const ordinals = [];
	let requests = 0;
	let transactions = 0;

	const t0 = env.now();
	let lower;
	for (;;) {
		const range = lower ? env.KeyRange.lowerBound(lower, true) : undefined;
		const tx = db.transaction(DATA_STORE, 'readonly');
		transactions++;
		requests += 2;
		const { keys, values } = await readPage(tx.objectStore(DATA_STORE), range, pageSize);
		for (const value of values) {
			if (secondaryOf(value) < k) ordinals.push(ordinalOf(value));
		}
		if (keys.length < pageSize) break;
		lower = keys[keys.length - 1];
	}
	return { ordinals, ms: env.now() - t0, requests, transactions };
}

/**
 * Arm D — span `getAll` plus set filter. Feeds the range-coalescing idea: instead of N point
 * reads, take the matched data keys from the index and sweep the single primary-key SPAN they
 * occupy, discarding rows whose key is not in the matched set.
 *
 * Timed end to end, index paging included, so it is directly comparable with arm A. At high
 * uniform selectivity the span is nearly the whole store, so the sweep is PAGED — an unbounded
 * `getAll` over it would measure a memory spike rather than I/O.
 *
 * NOTE: the membership test hexes every SWEPT key, so on a wide span this arm's timing carries
 * real JS string cost on top of its I/O — part of why it loses to a plain scan under uniform
 * scatter. Fine as a comparison against arm A (which the caller would also have to filter),
 * but if arm D ever becomes the basis for a real strategy, key the Set on something cheaper
 * (a typed-array trie, or the 4-byte key read as a u32) before quoting its numbers as the
 * strategy's cost.
 */
export async function armD(env, db, opts) {
	const { k } = opts;
	const pageSize = opts.pageSize ?? DEFAULT_PAGE;
	const ordinals = [];

	const t0 = env.now();
	const entries = await collectIndexEntries(env, db, k, pageSize);
	let requests = entries.requests;
	let transactions = entries.transactions;

	if (entries.dataKeys.length === 0) {
		return { ordinals, ms: env.now() - t0, requests, transactions, spanRows: 0 };
	}

	const wanted = new Set();
	let min = entries.dataKeys[0];
	let max = entries.dataKeys[0];
	for (const key of entries.dataKeys) {
		wanted.add(hexOf(key));
		if (env.cmp(key, min) < 0) min = key;
		if (env.cmp(key, max) > 0) max = key;
	}

	let spanRows = 0;
	let lower = { key: min, open: false };
	for (;;) {
		if (isEmptyRange(env, lower, { key: max, open: false })) break;
		const range = env.KeyRange.bound(lower.key, max, lower.open, false);
		const tx = db.transaction(DATA_STORE, 'readonly');
		transactions++;
		requests += 2;
		const { keys, values } = await readPage(tx.objectStore(DATA_STORE), range, pageSize);
		spanRows += keys.length;
		for (let i = 0; i < keys.length; i++) {
			if (wanted.has(hexOf(keys[i]))) ordinals.push(ordinalOf(values[i]));
		}
		if (keys.length < pageSize) break;
		lower = { key: keys[keys.length - 1], open: true };
	}
	return { ordinals, ms: env.now() - t0, requests, transactions, spanRows };
}

/* ------------------------------------------------------------------------------ arm E: writes */

/** Ordinals to update: an evenly spaced sample across the whole primary-key space. */
export function updateSample(dataset, count) {
	const stride = Math.max(1, Math.floor(dataset.rowCount / count));
	const out = [];
	for (let i = 0; i < dataset.rowCount && out.length < count; i += stride) out.push(i);
	return out;
}

/**
 * Arm E, two-store write side: changing a row's indexed value costs THREE writes — the row
 * itself, the removal of its old index entry, and the insertion of the new one — all in one
 * transaction spanning both stores, which is what the store module does today.
 */
export async function armEUpdateTwoStore(env, db, dataset, opts) {
	const { ordinals, valueShift } = opts;
	const chunk = opts.chunk ?? 500;
	let transactions = 0;
	const t0 = env.now();
	for (let start = 0; start < ordinals.length; start += chunk) {
		const tx = db.transaction([DATA_STORE, IDX_STORE], 'readwrite');
		transactions++;
		const data = tx.objectStore(DATA_STORE);
		const idx = tx.objectStore(IDX_STORE);
		for (let i = start; i < Math.min(start + chunk, ordinals.length); i++) {
			const row = dataset.rows[ordinals[i]];
			const next = row.secondary + valueShift;
			data.put(makeRowValue(row.ordinal, next), row.pk);
			idx.delete(row.indexKey);
			idx.put(row.pk, concatBuf(encU32(next), row.pk));
		}
		await txDone(tx);
	}
	return { ms: env.now() - t0, requests: ordinals.length * 3, transactions, rows: ordinals.length };
}

/**
 * Arm E, native write side: one `put` of the wrapped record. The engine does the index
 * maintenance the two-store arm pays for explicitly.
 */
export async function armEUpdateNative(env, db, dataset, opts) {
	const { ordinals, valueShift } = opts;
	const chunk = opts.chunk ?? 500;
	let transactions = 0;
	const t0 = env.now();
	for (let start = 0; start < ordinals.length; start += chunk) {
		const tx = db.transaction(DATA_STORE, 'readwrite');
		transactions++;
		const data = tx.objectStore(DATA_STORE);
		for (let i = start; i < Math.min(start + chunk, ordinals.length); i++) {
			const row = dataset.rows[ordinals[i]];
			const next = row.secondary + valueShift;
			data.put({ v: makeRowValue(row.ordinal, next), x: concatBuf(encU32(next), row.pk) }, row.pk);
		}
		await txDone(tx);
	}
	return { ms: env.now() - t0, requests: ordinals.length, transactions, rows: ordinals.length };
}

/* ------------------------------------------------------------------------------- statistics */

/** Median of a numeric list (even counts take the mean of the two middle samples). */
export function median(samples) {
	const sorted = [...samples].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Cheap fingerprint of a result set, for cross-arm agreement checks in the browser page where
 * keeping every ordinal array around would cost more memory than the benchmark itself. Count
 * plus a checksum catches both skipped and repeated rows. The Node smoke test compares full
 * sets instead — this is the page's coarse guard, not the correctness test.
 */
export function fingerprint(ordinals) {
	let sum = 0;
	let xor = 0;
	for (const ordinal of ordinals) {
		sum = (sum + ordinal) >>> 0;
		xor ^= ordinal;
	}
	return `${ordinals.length}:${sum}:${xor >>> 0}`;
}
