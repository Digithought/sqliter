/**
 * `ANALYZE` must record what the data actually contains.
 *
 * Nothing used to compare the two. The memory backend's `getStatistics()` derived every
 * per-column figure from a systematic sample of at most 1000 non-null values and reported it
 * as if it had read the whole column, so past 1000 rows `ANALYZE` recorded phantom NULLs for
 * every un-sampled row, a `distinctCount` saturated at the sample size, and the sample's
 * extremes as min/max. A test pinned to one table shape would not have caught it and would
 * not catch the next one.
 *
 * So this spec asserts an EQUIVALENCE rather than a value: for each generated table, every
 * figure `ANALYZE` records must equal the same figure computed by plain SQL over the same
 * table.
 *
 *   | recorded                          | must equal                              |
 *   |-----------------------------------|-----------------------------------------|
 *   | rowCount                          | select count(*) from t                  |
 *   | columnStats.get(c).nullCount      | select count(*) from t where c is null  |
 *   | columnStats.get(c).distinctCount  | select count(distinct c) from t         |
 *   | columnStats.get(c).minValue       | select min(c) from t                    |
 *   | columnStats.get(c).maxValue       | select max(c) from t                    |
 *
 * The generated shapes straddle the old 1000-value sample cap and cover the column kinds
 * whose statistics differ: all-null, some-null, no-null; high and low cardinality; integer
 * and text; primary-key, plain, and secondary-indexed.
 *
 * Gotcha for anyone extending this: `columnStats` is a `Map`. `Object.keys` and
 * `JSON.stringify` on it both show `{}`, which reads as "no statistics collected" — a
 * different and wrong conclusion. Use `.get(name)` / `[...map.keys()]`.
 *
 * Also note the scan keys its distinct sets by `String(value)`, so a column mixing the
 * integer 1 with the text '1' would count them as one value while SQL's `count(distinct)`
 * counts two. Every generated column here is single-typed; a mixed-type column is a real
 * (separate) question about what `distinctCount` should mean, not something to paper over
 * with a looser assertion.
 */

import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';
import type { TableStatistics } from '../../src/planner/stats/catalog-stats.js';

/** First column of the first row, or null when the query yielded nothing. */
async function scalar(db: Database, sql: string): Promise<SqlValue> {
	for await (const row of db.eval(sql)) {
		const values = Object.values(row as Record<string, SqlValue>);
		return values.length > 0 ? values[0] : null;
	}
	return null;
}

async function analyze(db: Database, table: string): Promise<void> {
	for await (const _ of db.eval(`analyze ${table}`)) { /* consume */ }
}

function recordedStats(db: Database, table: string): TableStatistics {
	const schema = db.schemaManager.findTable(table);
	expect(schema, `table ${table} should be registered`).to.not.be.undefined;
	expect(schema!.statistics, `ANALYZE should have recorded statistics for ${table}`).to.not.be.undefined;
	return schema!.statistics!;
}

/** `undefined` (no value seen) and SQL `null` (no row / all null) are the same fact here. */
function normalize(value: SqlValue | undefined): SqlValue {
	return value === undefined ? null : value;
}

/**
 * Assert every recorded figure against the plain-SQL figure for the same table.
 * `columns` names the columns to check; `label` disambiguates the failure message.
 */
async function expectStatisticsMatchData(
	db: Database,
	table: string,
	columns: readonly string[],
	label: string,
): Promise<void> {
	const stats = recordedStats(db, table);

	const trueRowCount = await scalar(db, `select count(*) as c from ${table}`);
	expect(stats.rowCount, `${label}: rowCount`).to.equal(trueRowCount);

	for (const column of columns) {
		const recorded = stats.columnStats.get(column.toLowerCase());
		expect(recorded, `${label}: statistics recorded for column ${column}`).to.not.be.undefined;

		const nulls = await scalar(db, `select count(*) as c from ${table} where ${column} is null`);
		expect(recorded!.nullCount, `${label}: ${column}.nullCount`).to.equal(nulls);

		const distinct = await scalar(db, `select count(distinct ${column}) as c from ${table}`);
		expect(recorded!.distinctCount, `${label}: ${column}.distinctCount`).to.equal(distinct);

		const min = await scalar(db, `select min(${column}) as m from ${table}`);
		expect(normalize(recorded!.minValue), `${label}: ${column}.minValue`).to.equal(min);

		const max = await scalar(db, `select max(${column}) as m from ${table}`);
		expect(normalize(recorded!.maxValue), `${label}: ${column}.maxValue`).to.equal(max);
	}
}

// ── The generated shapes ────────────────────────────────────────────────────

/**
 * One column of a generated table: its declaration, and the SQL literal it holds in row `i`
 * (1-based). Each is chosen to exercise a distinct axis of the statistics.
 */
interface GeneratedColumn {
	readonly name: string;
	readonly decl: string;
	readonly literal: (i: number) => string;
}

const COLUMNS: readonly GeneratedColumn[] = [
	// The primary key: distinct on every row, never null. The old code special-cased this
	// (distinctCount := rowCount) while leaving the sampled nullCount alone, so the two
	// disagreed with each other past 1000 rows.
	{ name: 'id', decl: 'id integer primary key', literal: (i) => String(i) },
	// Low-cardinality integer, secondary-indexed — the old code read its distinct count off
	// the index tree rather than the sample, so it is the one column that stayed right.
	{ name: 'g', decl: 'g integer', literal: (i) => String(i % 7) },
	// High-cardinality integer, no nulls. The headline symptom: distinctCount saturated at
	// 1000 and maxValue was the last sampled row.
	{ name: 'v', decl: 'v integer', literal: (i) => String(i) },
	// Low-cardinality text, no index.
	{ name: 'lo', decl: 'lo text', literal: (i) => `'g${i % 5}'` },
	// High-cardinality text: min/max under text collation, not numeric order.
	{ name: 'hi', decl: 'hi text', literal: (i) => `'t${i}'` },
	// Every row null: distinctCount 0, nullCount = rowCount, no min/max.
	{ name: 'allnull', decl: 'allnull integer null', literal: () => 'null' },
	// Some rows null: the arm the phantom-null bug corrupted in both directions.
	{ name: 'somenull', decl: 'somenull integer null', literal: (i) => (i % 3 === 0 ? 'null' : String(i)) },
];

const COLUMN_NAMES = COLUMNS.map((c) => c.name);

/** `create table` + the secondary index on `g`, then `rowCount` rows in batched inserts. */
async function createGeneratedTable(db: Database, table: string, rowCount: number): Promise<void> {
	await db.exec(`create table ${table} (${COLUMNS.map((c) => c.decl).join(', ')}) using memory`);
	await db.exec(`create index ${table}_g on ${table}(g)`);

	const BATCH = 250;
	for (let start = 1; start <= rowCount; start += BATCH) {
		const end = Math.min(start + BATCH - 1, rowCount);
		const tuples: string[] = [];
		for (let i = start; i <= end; i++) {
			tuples.push(`(${COLUMNS.map((c) => c.literal(i)).join(', ')})`);
		}
		await db.exec(`insert into ${table} values ${tuples.join(', ')}`);
	}
}

/**
 * Row counts straddling the 1000-value cap the old sampler used. 999 / 1000 / 1001 bracket
 * it exactly; 2500 is far enough past it that a systematic sample skips four rows in five.
 */
const ROW_COUNTS = [0, 3, 999, 1000, 1001, 2500] as const;

describe('ANALYZE records what the data contains (memory backend)', () => {
	let db: Database | undefined;

	afterEach(async () => {
		await db?.close();
		db = undefined;
	});

	for (const rowCount of ROW_COUNTS) {
		it(`matches plain SQL over a ${rowCount}-row table`, async function () {
			this.timeout(60000);
			db = new Database();
			await createGeneratedTable(db, 't', rowCount);
			await analyze(db, 't');
			await expectStatisticsMatchData(db, 't', COLUMN_NAMES, `${rowCount} rows`);
		});
	}

	// The exact numbers from the bug report, so a reader can check the arithmetic by eye:
	// with 5000 rows and a 1000-value cap the old sampler stepped by 5, giving rows
	// 1, 6, … 4996 — hence distinct=1000, nullCount=4000, max=4996 for `v`.
	it('records 5000 distinct values and no nulls for a 1..5000 column', async function () {
		this.timeout(60000);
		db = new Database();
		await db.exec('create table big (id integer primary key, g integer, v integer) using memory');
		const BATCH = 250;
		for (let start = 1; start <= 5000; start += BATCH) {
			const tuples: string[] = [];
			for (let i = start; i < start + BATCH; i++) tuples.push(`(${i}, ${i % 7}, ${i})`);
			await db.exec(`insert into big values ${tuples.join(', ')}`);
		}

		await analyze(db, 'big');
		const stats = recordedStats(db, 'big');

		expect(stats.rowCount).to.equal(5000);
		const v = stats.columnStats.get('v')!;
		expect(v.distinctCount, 'distinctCount (was 1000, the sample cap)').to.equal(5000);
		expect(v.nullCount, 'nullCount (was 4000, the un-sampled rows)').to.equal(0);
		expect(v.minValue).to.equal(1);
		expect(v.maxValue, 'maxValue (was 4996, the last sampled row)').to.equal(5000);

		const id = stats.columnStats.get('id')!;
		expect(id.distinctCount).to.equal(5000);
		expect(id.nullCount, 'a primary key column has no nulls').to.equal(0);

		await expectStatisticsMatchData(db, 'big', ['id', 'g', 'v'], '5000 rows');
	});

	// The memory backend's own report reads the COMMITTED base layer only, so inside an open
	// transaction it describes the table as it was before the transaction started. ANALYZE
	// must record what the connection can actually see.
	it('records the in-transaction row count, not the committed base', async function () {
		this.timeout(60000);
		db = new Database();
		await db.exec('create table tx (id integer primary key, v integer) using memory');
		await db.exec('insert into tx values (1, 10), (2, 20)');

		await db.exec('begin');
		const tuples: string[] = [];
		for (let i = 3; i <= 102; i++) tuples.push(`(${i}, ${i * 10})`);
		await db.exec(`insert into tx values ${tuples.join(', ')}`);

		expect(await scalar(db, 'select count(*) as c from tx'), 'the connection sees its own writes')
			.to.equal(102);

		await analyze(db, 'tx');
		await expectStatisticsMatchData(db, 'tx', ['id', 'v'], 'inside a transaction');

		await db.exec('rollback');
	});
});
