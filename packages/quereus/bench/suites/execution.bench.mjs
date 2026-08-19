/**
 * TIMING: no benchmark in this file sets `iterations` or `warmup`. The worker warms
 * `fn` up by elapsed duration and then measures the WARMED function to pick both —
 * see `CALIBRATION` in `bench/lib/calibrate.mjs` — so each benchmark gets roughly a
 * second of timed work regardless of whether one call costs microseconds or hundreds
 * of milliseconds.
 *
 * Setting either field is still honoured and PINS the benchmark to a fixed count,
 * skipping calibration entirely. It is the escape hatch for a benchmark whose
 * per-call cost changes as it runs, where a few warm calls would not represent the
 * rest. Use it only with a comment saying why: a pinned benchmark also forfeits a
 * meaningful spread figure, because ten samples are too few for a quartile range to
 * say much.
 *
 * Calibration BATCHES sub-millisecond benchmarks — several consecutive `fn` calls
 * timed as one sample — so every `fn` here must be repeatable back-to-back without
 * its `setup` in between. All of them are; a future one that is not (say, a
 * benchmark that grows a table on each call) must reset itself inside `fn` or pin
 * itself out of calibration.
 */

import { Database } from '../../dist/src/index.js';
import { snapshotStatement } from '../lib/counters.mjs';

/** Collect an async iterable into an array. */
async function collect(iter) {
	const out = [];
	for await (const item of iter) out.push(item);
	return out;
}

/** Build and populate a 10K-row database. */
async function createPopulatedDb() {
	const db = new Database();
	await db.exec(`
		create table bench_t (id integer primary key, val integer, label text);
		create index bench_t_val on bench_t (val);
	`);

	// Insert 10K rows in batches of 500
	for (let batch = 0; batch < 20; batch++) {
		const values = Array.from({ length: 500 }, (_, j) => {
			const id = batch * 500 + j + 1;
			return `(${id}, ${id * 7 % 1000}, 'group_${id % 100}')`;
		}).join(', ');
		await db.exec(`insert into bench_t values ${values}`);
	}

	return db;
}

/** 40 identical leading characters — forces a comparator to scan past a long common
 * prefix before it finds a differing character, the opposite cost profile of keys
 * that differ at character 1. */
const PREFIX40 = 'p'.repeat(40);

/** One astral emoji (U+1F600, outside the Basic Multilingual Plane) plus one rare
 * CJK Extension B ideograph (U+20000) — both are surrogate pairs in UTF-16, so any
 * string containing them takes `compareCodePoints`'s surrogate-aware slow path
 * instead of its native `<`/`>` fast path (see `util/comparison.ts`). */
const UNICODE_PREFIX = '\u{1F600}\u{20000}';

/**
 * Build and populate a 10K-row database with several text columns, each shaped for a
 * different comparator workload: `tkey` is unique text (order by / point compares),
 * `label` is low-cardinality text (group by / distinct), `tkey_prefixed` shares a
 * 40-char prefix across every row, and `tkey_unicode` carries astral code points.
 */
async function createTextDb() {
	const db = new Database();
	await db.exec(`
		create table bench_text_t (
			id integer primary key,
			tkey text,
			label text,
			tkey_prefixed text,
			tkey_unicode text
		);
	`);

	for (let batch = 0; batch < 20; batch++) {
		const values = Array.from({ length: 500 }, (_, j) => {
			const id = batch * 500 + j + 1;
			// Scramble the key so it does NOT ascend with insertion order. V8's sort is
			// TimSort, which spends exactly n-1 comparisons on an already-ordered input —
			// an ascending key would make these `order by` benchmarks O(n) comparisons
			// instead of O(n log n) and hide most of the per-comparison cost they exist to
			// measure. `7919` is coprime with 100000, so the map stays injective (`tkey`
			// unique, as `distinct-text-10k` asserts).
			const suffix = String((id * 7919) % 100000).padStart(5, '0');
			return `(${id}, 'key_${suffix}', 'group_${id % 100}', '${PREFIX40}${suffix}', '${UNICODE_PREFIX}${suffix}')`;
		}).join(', ');
		await db.exec(`insert into bench_text_t values ${values}`);
	}

	return db;
}

/**
 * Build and populate a 10K-row database with a DATE column and a TIMESPAN column,
 * so `d + s` over a full scan is one temporal add per row. Both columns are
 * DECLARED temporal, which is what lets `buildNumericOpSpec` resolve the
 * (operator, kind, kind) case once at emit instead of re-deriving both operand
 * kinds from the values on every row (see runtime/emit/binary.ts).
 */
async function createTemporalDb() {
	const db = new Database();
	await db.exec('create table bench_temporal_t (id integer primary key, d date, s timespan)');

	for (let batch = 0; batch < 20; batch++) {
		const values = Array.from({ length: 500 }, (_, j) => {
			const id = batch * 500 + j + 1;
			// Spread over 2024 (a leap year, 366 days) so the dates are not all identical.
			const day = String((id % 28) + 1).padStart(2, '0');
			const month = String((id % 12) + 1).padStart(2, '0');
			return `(${id}, '2024-${month}-${day}', 'P${(id % 30) + 1}D')`;
		}).join(', ');
		await db.exec(`insert into bench_temporal_t values ${values}`);
	}

	return db;
}

/** Build and populate a 10K-row database with a text primary key (zero-padded so
 * lexicographic order matches insertion order, making range bounds predictable). */
async function createTextPkDb() {
	const db = new Database();
	await db.exec('create table bench_text_pk (tkey text primary key, val integer)');

	for (let batch = 0; batch < 20; batch++) {
		const values = Array.from({ length: 500 }, (_, j) => {
			const id = batch * 500 + j + 1;
			return `('key_${String(id).padStart(5, '0')}', ${id})`;
		}).join(', ');
		await db.exec(`insert into bench_text_pk values ${values}`);
	}

	return db;
}

/**
 * Every benchmark's query, named once and used twice: `fn` times it, and `counters()`
 * snapshots the same statement after timing. Sharing one literal is what keeps the two
 * from drifting — a query edited in `fn` alone would leave the counters pass reporting
 * counts for a statement the benchmark no longer runs, and the counts would still look
 * perfectly stable while describing the wrong plan.
 */
const SQL = {
	fullScan: 'select * from bench_t',
	temporalArith: 'select d + s as a from bench_temporal_t',
	filteredScanIndex: 'select * from bench_t where val = 42',
	groupBy: 'select label, count(*) as cnt, sum(val) as total from bench_t group by label',
	orderBy: 'select * from bench_t order by val desc, id asc',
	orderByText: 'select * from bench_text_t order by tkey',
	orderByTextPrefix40: 'select * from bench_text_t order by tkey_prefixed',
	orderByTextUnicode: 'select * from bench_text_t order by tkey_unicode',
	groupByText: 'select label, count(*) as cnt from bench_text_t group by label',
	distinctText: 'select distinct tkey from bench_text_t',
	textPkRangeScan: "select * from bench_text_pk where tkey >= 'key_03000' and tkey < 'key_04000'",
	textPkPointSeek: "select * from bench_text_pk where tkey = 'key_05000'",
	join: 'select l.id, r.payload from left_t l join right_t r on l.key_col = r.key_col where l.id <= 100',
	correlatedSubquery: `
		select id, val,
			(select count(*) from bench_t b where b.label = a.label) as peer_count
		from bench_t a
		where a.id <= 100
	`,
	handBatchedPeerCount: `
		select a.id, a.val, coalesce(g.cnt, 0) as peer_count
		from bench_t a
		left join (select label, count(*) as cnt from bench_t group by label) g on g.label = a.label
		where a.id <= 100
	`,
};

let db;

export const benchmarks = [
	{
		name: 'full-scan-10k',
		async setup() { db = await createPopulatedDb(); },
		async teardown() { await db.close(); db = null; },
		async fn() {
			const rows = await collect(db.eval(SQL.fullScan));
			if (rows.length !== 10000) throw new Error(`Expected 10000 rows, got ${rows.length}`);
		},
		// Runs ONCE after timing, with metrics on — never inside `fn`, whose number the
		// counting generators would corrupt. Same statement, fully drained. Every other
		// `counters()` in this file follows this shape.
		counters() { return snapshotStatement(db, SQL.fullScan); },
	},
	{
		// One DATE + TIMESPAN add per row over a full scan. Both operands are declared
		// temporal, so the operation-table lookup resolves at emit and the per-row path
		// is a single call into the selected case; before that, each row re-derived both
		// operand kinds from the values (four regex/prefix probes each). Scan overhead is
		// shared with `full-scan-10k`, so the delta between the two isolates the add.
		//
		// NOTE: deliberately NOT given a `ratioGuards` entry — those bound a pathological
		// plan regression (an N+1 scan), not a constant factor like this one.
		//
		// NOTE: measured ~90 ms specialized vs ~103 ms on the value-sniffed body (medians of
		// 4 runs each, `full-scan-10k` steady at ~12 ms across all 8). So dispatch is ~1.2 µs
		// of the ~9 µs each row spends here — the other ~8 µs is temporal-polyfill parsing
		// (`Temporal.PlainDate.from` + `Temporal.Duration.from`, re-parsed per row even when
		// one operand is a constant). If this shape ever needs to be materially faster,
		// that parse is the target, not the dispatch.
		name: 'temporal-arith-scan-10k',
		async setup() { db = await createTemporalDb(); },
		async teardown() { await db.close(); db = null; },
		async fn() {
			const rows = await collect(db.eval(SQL.temporalArith));
			if (rows.length !== 10000) throw new Error(`Expected 10000 rows, got ${rows.length}`);
		},
		counters() { return snapshotStatement(db, SQL.temporalArith); },
	},
	{
		name: 'filtered-scan-index-10k',
		async setup() { db = await createPopulatedDb(); },
		async teardown() { await db.close(); db = null; },
		async fn() {
			const rows = await collect(db.eval(SQL.filteredScanIndex));
			if (rows.length === 0) throw new Error('Expected some rows');
		},
		counters() { return snapshotStatement(db, SQL.filteredScanIndex); },
	},
	{
		name: 'group-by-10k',
		async setup() { db = await createPopulatedDb(); },
		async teardown() { await db.close(); db = null; },
		async fn() {
			const rows = await collect(db.eval(SQL.groupBy));
			if (rows.length !== 100) throw new Error(`Expected 100 groups, got ${rows.length}`);
		},
		counters() { return snapshotStatement(db, SQL.groupBy); },
	},
	{
		name: 'order-by-10k',
		async setup() { db = await createPopulatedDb(); },
		async teardown() { await db.close(); db = null; },
		async fn() {
			const rows = await collect(db.eval(SQL.orderBy));
			if (rows.length !== 10000) throw new Error(`Expected 10000 rows, got ${rows.length}`);
		},
		counters() { return snapshotStatement(db, SQL.orderBy); },
	},
	{
		name: 'order-by-text-10k',
		async setup() { db = await createTextDb(); },
		async teardown() { await db.close(); db = null; },
		async fn() {
			const rows = await collect(db.eval(SQL.orderByText));
			if (rows.length !== 10000) throw new Error(`Expected 10000 rows, got ${rows.length}`);
		},
		counters() { return snapshotStatement(db, SQL.orderByText); },
	},
	{
		// Every key shares the same 40-char prefix (`PREFIX40`), so the comparator can
		// never resolve on its fast early bytes — the opposite cost profile of
		// `order-by-text-10k`, where keys diverge at character 5.
		//
		// NOTE: an earlier revision of this comment claimed ~380 ms/iteration and ~4.5 s of
		// the total run, and called this the most expensive entry in the suite. All of that
		// was wrong. Under the per-benchmark process isolation the harness now enforces
		// (Windows 11, node 24.2), four full runs put it at 67-91 ms/iteration — well under
		// a second of a 23-42 s run — and in every one of them at least four other entries
		// cost more, among them `temporal-arith-scan-10k` (85-118 ms), `mutation/bulk-
		// insert-10k` (121-173 ms), `mutation/delete-where-100` and
		// `mutation/single-row-insert-1k` (both ~100-120 ms).
		//
		// Do not read those figures as bounds. Runs taken while the machine was busy measured
		// this same benchmark at 228-338 ms, so background load moves it several-fold; the
		// ordering above is the durable claim, not the milliseconds. The `Spread` column now
		// reports how much of that noise landed inside a given run — but only inside it; a
		// whole run displaced by background load still reads as tight.
		//
		// If `yarn bench` wall-clock ever becomes a problem this is not the entry to cut, and
		// if it ever is, lower `CALIBRATION.targetTotalMs` in `bench/lib/calibrate.mjs` (which shortens
		// every benchmark evenly) rather than shortening `PREFIX40` — the long prefix is the
		// whole point of the benchmark.
		name: 'order-by-text-prefix40-10k',
		async setup() { db = await createTextDb(); },
		async teardown() { await db.close(); db = null; },
		async fn() {
			const rows = await collect(db.eval(SQL.orderByTextPrefix40));
			if (rows.length !== 10000) throw new Error(`Expected 10000 rows, got ${rows.length}`);
		},
		counters() { return snapshotStatement(db, SQL.orderByTextPrefix40); },
	},
	{
		// Every key carries an astral emoji + a CJK Extension B ideograph
		// (`UNICODE_PREFIX`), forcing `compareCodePoints`'s surrogate-aware slow path
		// (see `util/comparison.ts`) rather than its native `<`/`>` fast path.
		name: 'order-by-text-unicode-10k',
		async setup() { db = await createTextDb(); },
		async teardown() { await db.close(); db = null; },
		async fn() {
			const rows = await collect(db.eval(SQL.orderByTextUnicode));
			if (rows.length !== 10000) throw new Error(`Expected 10000 rows, got ${rows.length}`);
		},
		counters() { return snapshotStatement(db, SQL.orderByTextUnicode); },
	},
	{
		// NOTE: grouping is hash-based (`runtime/emit/hash-aggregate.ts` serializes each key
		// through a collation key normalizer into a `Map`), so this measures the text
		// key-serialization path, NOT `compareCodePoints` — a pure comparator regression does
		// not move this number. `distinct-text-10k` is the comparator-sensitive dedup case.
		name: 'group-by-text-10k',
		async setup() { db = await createTextDb(); },
		async teardown() { await db.close(); db = null; },
		async fn() {
			const rows = await collect(db.eval(SQL.groupByText));
			if (rows.length !== 100) throw new Error(`Expected 100 groups, got ${rows.length}`);
		},
		counters() { return snapshotStatement(db, SQL.groupByText); },
	},
	{
		// `tkey` is unique per row, so dedup must compare all 10K values rather than
		// collapsing into `group-by-text-10k`'s 100 low-cardinality groups.
		name: 'distinct-text-10k',
		async setup() { db = await createTextDb(); },
		async teardown() { await db.close(); db = null; },
		async fn() {
			const rows = await collect(db.eval(SQL.distinctText));
			if (rows.length !== 10000) throw new Error(`Expected 10000 distinct rows, got ${rows.length}`);
		},
		counters() { return snapshotStatement(db, SQL.distinctText); },
	},
	{
		name: 'text-pk-range-scan-10k',
		async setup() { db = await createTextPkDb(); },
		async teardown() { await db.close(); db = null; },
		async fn() {
			const rows = await collect(db.eval(SQL.textPkRangeScan));
			if (rows.length !== 1000) throw new Error(`Expected 1000 rows, got ${rows.length}`);
		},
		counters() { return snapshotStatement(db, SQL.textPkRangeScan); },
	},
	{
		name: 'text-pk-point-seek-10k',
		async setup() { db = await createTextPkDb(); },
		async teardown() { await db.close(); db = null; },
		async fn() {
			const rows = await collect(db.eval(SQL.textPkPointSeek));
			if (rows.length !== 1) throw new Error(`Expected 1 row, got ${rows.length}`);
		},
		counters() { return snapshotStatement(db, SQL.textPkPointSeek); },
	},
	{
		name: 'join-1kx1k',
		async setup() {
			db = new Database();
			await db.exec(`
				create table left_t (id integer primary key, key_col integer);
				create table right_t (id integer primary key, key_col integer, payload text);
			`);
			const leftVals = Array.from({ length: 1000 }, (_, i) =>
				`(${i + 1}, ${i % 100})`
			).join(', ');
			const rightVals = Array.from({ length: 1000 }, (_, i) =>
				`(${i + 1}, ${i % 100}, 'data_${i}')`
			).join(', ');
			await db.exec(`insert into left_t values ${leftVals}`);
			await db.exec(`insert into right_t values ${rightVals}`);
		},
		async teardown() { await db.close(); db = null; },
		async fn() {
			const rows = await collect(db.eval(SQL.join));
			if (rows.length === 0) throw new Error('Expected join results');
		},
		counters() { return snapshotStatement(db, SQL.join); },
	},
	{
		name: 'correlated-subquery',
		async setup() { db = await createPopulatedDb(); },
		async teardown() { await db.close(); db = null; },
		async fn() {
			const rows = await collect(db.eval(SQL.correlatedSubquery));
			if (rows.length !== 100) throw new Error(`Expected 100 rows, got ${rows.length}`);
		},
		// The counter that would catch `scalar-agg-decorrelation` breaking BEFORE the
		// `ratioGuards` entry below does: an N+1 regression multiplies `queryCalls` and
		// `rowsScanned` on `main.bench_t`, and unlike the ratio it needs no second
		// benchmark and has no variance to tolerate.
		counters() { return snapshotStatement(db, SQL.correlatedSubquery); },
	},
	{
		// Hand-batched twin of `correlated-subquery`: the identical result via an
		// explicit grouped join — the shape the optimizer should produce when
		// `scalar-agg-decorrelation` fires. The `ratioGuards` entry below compares
		// the two: when decorrelation works the plans are near-identical (ratio ≈
		// 1); if it breaks, the declarative side goes N+1 and the ratio spikes.
		name: 'hand-batched-peer-count',
		async setup() { db = await createPopulatedDb(); },
		async teardown() { await db.close(); db = null; },
		async fn() {
			const rows = await collect(db.eval(SQL.handBatchedPeerCount));
			if (rows.length !== 100) throw new Error(`Expected 100 rows, got ${rows.length}`);
		},
		counters() { return snapshotStatement(db, SQL.handBatchedPeerCount); },
	},
];

/**
 * Within-run shape-economy guards. Each guard is a ratio of one benchmark's
 * median to another's, checked inside a single run (independent of any
 * `--baseline` file). `correlated-subquery` relies on `scalar-agg-decorrelation`
 * to become the same grouped-join plan a human writes by hand
 * (`hand-batched-peer-count`); when the rule fires the two are near-identical
 * (ratio ≈ 1). If decorrelation ever breaks, the declarative side re-runs its
 * inner count(*) once per outer row (an "N+1 scan", ~26× in the original
 * post-mortem) and the ratio spikes past `maxRatio`.
 *
 * `maxRatio` is deliberately LOOSE (order-of-magnitude): its job is to trip the
 * 26×-class regression, not order-of-1 warm-up variance on the in-memory vtab.
 * If the twin ever shows high variance near the bound, raise
 * `CALIBRATION.targetTotalMs` in `bench/lib/calibrate.mjs` so both sides collect more
 * samples, rather than tightening `maxRatio`.
 */
export const ratioGuards = [
	{ name: 'correlated-subquery', baseline: 'hand-batched-peer-count', maxRatio: 10 },
];
