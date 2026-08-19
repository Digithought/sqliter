/**
 * The `execution` suite's workloads, as DATA.
 *
 * Lifted out of `bench/suites/execution.bench.mjs` so one definition can be measured
 * against several storage backends (see `bench/lib/backends.mjs`). The suite file is
 * now a binder: it turns each `Workload` here into the `setup`/`fn`/`teardown`/
 * `counters` shape the worker expects, once per backend.
 *
 * A fixture here POPULATES a database it is handed; it never constructs one. Which
 * database — and therefore which storage engine — is the backend's decision.
 */

/**
 * One single-statement query workload.
 *
 * @typedef {object} Workload
 * @property {string} name the bare benchmark name, e.g. `full-scan-10k`. The default
 *   backend publishes it unchanged; every other backend appends its own id.
 * @property {string} fixture which entry of `FIXTURES` builds its tables
 * @property {string} sql the ONE statement `fn` times and `counters()` snapshots.
 *   Named once and used twice on purpose: a query edited in `fn` alone would leave the
 *   counters pass reporting counts for a statement the benchmark no longer runs, and
 *   those counts would look perfectly stable while describing the wrong plan.
 * @property {number} expectedRows asserted by `fn`. A query that silently returns zero
 *   rows is very fast and completely meaningless — see docs/benchmarking.md.
 *
 * MUTATION IS NOT ALLOWED HERE. Calibration batches sub-millisecond benchmarks —
 * several consecutive `fn` calls timed as one sample — so `sql` must be repeatable
 * back-to-back against the same fixture without `setup` in between. A workload whose
 * statement grows or shrinks its own table belongs in the `mutation` suite, which owns
 * the per-iteration database lifecycle that makes such a thing measurable.
 */

/** 40 identical leading characters — forces a comparator to scan past a long common
 * prefix before it finds a differing character, the opposite cost profile of keys
 * that differ at character 1. */
const PREFIX40 = 'p'.repeat(40);

/** One astral emoji (U+1F600, outside the Basic Multilingual Plane) plus one rare
 * CJK Extension B ideograph (U+20000) — both are surrogate pairs in UTF-16, so any
 * string containing them takes `compareCodePoints`'s surrogate-aware slow path
 * instead of its native `<`/`>` fast path (see `util/comparison.ts`). */
const UNICODE_PREFIX = '\u{1F600}\u{20000}';

/** Rows per `insert ... values` batch. */
const BATCH_ROWS = 500;
/** Batches per fixture — 20 × 500 = the 10K rows the benchmark names advertise. */
const BATCH_COUNT = 20;

/**
 * Insert `BATCH_COUNT` batches of `BATCH_ROWS` rows, one `insert ... values` statement
 * per batch. Shared by all four fixtures so they populate identically and differ only
 * in the tuples they render.
 *
 * @param {import('../../dist/src/index.js').Database} db
 * @param {string} table
 * @param {(id: number) => string} row renders one row's `(...)` tuple from its 1-based id
 */
async function populate(db, table, row) {
	for (let batch = 0; batch < BATCH_COUNT; batch++) {
		const values = Array.from({ length: BATCH_ROWS }, (_, j) => row(batch * BATCH_ROWS + j + 1)).join(', ');
		await db.exec(`insert into ${table} values ${values}`);
	}
}

/** Populate a 10K-row integer table with a secondary index.
 * @param {import('../../dist/src/index.js').Database} db */
export async function createPopulatedDb(db) {
	await db.exec(`
		create table bench_t (id integer primary key, val integer, label text);
		create index bench_t_val on bench_t (val);
	`);
	await populate(db, 'bench_t', (id) => `(${id}, ${id * 7 % 1000}, 'group_${id % 100}')`);
}

/**
 * Populate a 10K-row table with several text columns, each shaped for a different
 * comparator workload: `tkey` is unique text (order by / point compares), `label` is
 * low-cardinality text (group by / distinct), `tkey_prefixed` shares a 40-char prefix
 * across every row, and `tkey_unicode` carries astral code points.
 *
 * @param {import('../../dist/src/index.js').Database} db
 */
export async function createTextDb(db) {
	await db.exec(`
		create table bench_text_t (
			id integer primary key,
			tkey text,
			label text,
			tkey_prefixed text,
			tkey_unicode text
		);
	`);
	await populate(db, 'bench_text_t', (id) => {
		// Scramble the key so it does NOT ascend with insertion order. V8's sort is
		// TimSort, which spends exactly n-1 comparisons on an already-ordered input —
		// an ascending key would make these `order by` benchmarks O(n) comparisons
		// instead of O(n log n) and hide most of the per-comparison cost they exist to
		// measure. `7919` is coprime with 100000, so the map stays injective (`tkey`
		// unique, as `distinct-text-10k` asserts).
		const suffix = String((id * 7919) % 100000).padStart(5, '0');
		return `(${id}, 'key_${suffix}', 'group_${id % 100}', '${PREFIX40}${suffix}', '${UNICODE_PREFIX}${suffix}')`;
	});
}

/**
 * Populate a 10K-row table with a DATE column and a TIMESPAN column, so `d + s` over a
 * full scan is one temporal add per row. Both columns are DECLARED temporal, which is
 * what lets `buildNumericOpSpec` resolve the (operator, kind, kind) case once at emit
 * instead of re-deriving both operand kinds from the values on every row (see
 * runtime/emit/binary.ts).
 *
 * @param {import('../../dist/src/index.js').Database} db
 */
export async function createTemporalDb(db) {
	await db.exec('create table bench_temporal_t (id integer primary key, d date, s timespan)');
	await populate(db, 'bench_temporal_t', (id) => {
		// Spread over 2024 (a leap year, 366 days) so the dates are not all identical.
		const day = String((id % 28) + 1).padStart(2, '0');
		const month = String((id % 12) + 1).padStart(2, '0');
		return `(${id}, '2024-${month}-${day}', 'P${(id % 30) + 1}D')`;
	});
}

/** Populate a 10K-row table with a text primary key (zero-padded so lexicographic
 * order matches insertion order, making range bounds predictable).
 * @param {import('../../dist/src/index.js').Database} db */
export async function createTextPkDb(db) {
	await db.exec('create table bench_text_pk (tkey text primary key, val integer)');
	await populate(db, 'bench_text_pk', (id) => `('key_${String(id).padStart(5, '0')}', ${id})`);
}

/**
 * Populate the two 1 000-row tables `join-1kx1k` joins. A fixture is a function over a
 * database, not a table: nothing stops one from building several, which is why a
 * multi-table workload needs no shape of its own.
 *
 * Both tables carry `key_col = i % 100`, so each of the 100 keys matches ten rows on
 * each side. Written as one `insert ... values` per table rather than through
 * `populate`, because 1 000 rows fit in a single statement and batching them would
 * change what this fixture costs.
 *
 * @param {import('../../dist/src/index.js').Database} db
 */
export async function createJoinDb(db) {
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
}

/**
 * The fixtures a `Workload.fixture` names. Addressed by string rather than by function
 * reference so a workload stays plain data — the thing a future suite could read from a
 * file or generate.
 *
 * @type {Record<string, (db: import('../../dist/src/index.js').Database) => Promise<void>>}
 */
export const FIXTURES = {
	populated: createPopulatedDb,
	text: createTextDb,
	temporal: createTemporalDb,
	textPk: createTextPkDb,
	join: createJoinDb,
};

/**
 * The single-statement query workloads, in the order they run.
 *
 * @type {Workload[]}
 */
export const QUERY_WORKLOADS = [
	{
		name: 'full-scan-10k',
		fixture: 'populated',
		sql: 'select * from bench_t',
		expectedRows: 10000,
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
		fixture: 'temporal',
		sql: 'select d + s as a from bench_temporal_t',
		expectedRows: 10000,
	},
	{
		// `val = id * 7 % 1000`, so `val = 42` selects `id ≡ 6 (mod 1000)` — ten of the
		// 10,000 rows. Stated exactly rather than as "some rows": an index regression that
		// started returning the whole table would still satisfy a non-zero check.
		name: 'filtered-scan-index-10k',
		fixture: 'populated',
		sql: 'select * from bench_t where val = 42',
		expectedRows: 10,
	},
	{
		name: 'group-by-10k',
		fixture: 'populated',
		sql: 'select label, count(*) as cnt, sum(val) as total from bench_t group by label',
		expectedRows: 100,
	},
	{
		name: 'order-by-10k',
		fixture: 'populated',
		sql: 'select * from bench_t order by val desc, id asc',
		expectedRows: 10000,
	},
	{
		name: 'order-by-text-10k',
		fixture: 'text',
		sql: 'select * from bench_text_t order by tkey',
		expectedRows: 10000,
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
		fixture: 'text',
		sql: 'select * from bench_text_t order by tkey_prefixed',
		expectedRows: 10000,
	},
	{
		// Every key carries an astral emoji + a CJK Extension B ideograph
		// (`UNICODE_PREFIX`), forcing `compareCodePoints`'s surrogate-aware slow path
		// (see `util/comparison.ts`) rather than its native `<`/`>` fast path.
		name: 'order-by-text-unicode-10k',
		fixture: 'text',
		sql: 'select * from bench_text_t order by tkey_unicode',
		expectedRows: 10000,
	},
	{
		// NOTE: grouping is hash-based (`runtime/emit/hash-aggregate.ts` serializes each key
		// through a collation key normalizer into a `Map`), so this measures the text
		// key-serialization path, NOT `compareCodePoints` — a pure comparator regression does
		// not move this number. `distinct-text-10k` is the comparator-sensitive dedup case.
		name: 'group-by-text-10k',
		fixture: 'text',
		sql: 'select label, count(*) as cnt from bench_text_t group by label',
		expectedRows: 100,
	},
	{
		// `tkey` is unique per row, so dedup must compare all 10K values rather than
		// collapsing into `group-by-text-10k`'s 100 low-cardinality groups.
		name: 'distinct-text-10k',
		fixture: 'text',
		sql: 'select distinct tkey from bench_text_t',
		expectedRows: 10000,
	},
	{
		name: 'text-pk-range-scan-10k',
		fixture: 'textPk',
		sql: "select * from bench_text_pk where tkey >= 'key_03000' and tkey < 'key_04000'",
		expectedRows: 1000,
	},
	{
		name: 'text-pk-point-seek-10k',
		fixture: 'textPk',
		sql: "select * from bench_text_pk where tkey = 'key_05000'",
		expectedRows: 1,
	},
	{
		// `l.id <= 100` selects left rows 1..100, whose `key_col` covers 0..99 once each;
		// every one of those keys matches ten rows of `right_t`, so the join emits 1 000.
		// Stated exactly rather than as "some rows": the assertion this replaced only
		// checked the count was non-zero, which a join that had collapsed to one match per
		// key would still have satisfied.
		name: 'join-1kx1k',
		fixture: 'join',
		sql: 'select l.id, r.payload from left_t l join right_t r on l.key_col = r.key_col where l.id <= 100',
		expectedRows: 1000,
	},
];

/**
 * The decorrelation twin pair, kept as its own group because the two only mean
 * anything together: `execution.bench.mjs`'s `ratioGuards` entry bounds the first
 * against the second, and both must exist in a run for that guard to evaluate.
 *
 * They run last, after every entry in `QUERY_WORKLOADS`. Separating them costs one
 * extra export and buys a group a reader can see is a pair; appending them would put
 * a guarded twin in the middle of a list of unrelated single queries.
 *
 * @type {Workload[]}
 */
export const DECORRELATION_WORKLOADS = [
	{
		name: 'correlated-subquery',
		fixture: 'populated',
		sql: `
		select id, val,
			(select count(*) from bench_t b where b.label = a.label) as peer_count
		from bench_t a
		where a.id <= 100
	`,
		expectedRows: 100,
	},
	{
		// Hand-batched twin of `correlated-subquery`: the identical result via an
		// explicit grouped join — the shape the optimizer should produce when
		// `scalar-agg-decorrelation` fires. The `ratioGuards` entry in the suite file
		// compares the two: when decorrelation works the plans are near-identical
		// (ratio ≈ 1); if it breaks, the declarative side goes N+1 and the ratio spikes.
		name: 'hand-batched-peer-count',
		fixture: 'populated',
		sql: `
		select a.id, a.val, coalesce(g.cnt, 0) as peer_count
		from bench_t a
		left join (select label, count(*) as cnt from bench_t group by label) g on g.label = a.label
		where a.id <= 100
	`,
		expectedRows: 100,
	},
];
