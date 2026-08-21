/**
 * The store-backend arm of "`ANALYZE` records what the data contains".
 *
 * `StoreTable.getStatistics()` reports a row count with an EMPTY `columnStats`, which
 * `ANALYZE` reads as "size answered, collect the rest yourself" — so every per-column figure
 * comes from the engine's shared scan collector. The memory backend now reports the same way
 * (it used to invent column figures from a 1000-value sample), which makes that scan the one
 * code path both backends depend on. This spec pins the store side of it so a change there
 * cannot silently diverge.
 *
 * Same equivalence as `packages/quereus/test/optimizer/analyze-stats-equivalence.spec.ts`:
 * every figure `ANALYZE` records must equal the same figure computed by plain SQL. The
 * exhaustive shape matrix lives on the memory side; this side runs a couple of shapes just
 * past the 1000-row mark, where the memory backend's sampling used to go wrong, plus the
 * in-transaction case.
 *
 * Gotcha: `columnStats` is a `Map`. `Object.keys` / `JSON.stringify` on it show `{}`, which
 * reads as "no statistics collected" — a different and wrong conclusion.
 */

import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, asyncIterableToArray } from '@quereus/quereus';
import type { SqlValue, TableStatistics } from '@quereus/quereus';
import { StoreModule, InMemoryKVStore, type KVStoreProvider } from '../src/index.js';

/** An in-memory provider — keeps the whole spec in-process and fast. */
function createInMemoryProvider(): KVStoreProvider {
	const stores = new Map<string, InMemoryKVStore>();
	const get = (key: string): InMemoryKVStore => {
		let s = stores.get(key);
		if (!s) { s = new InMemoryKVStore(); stores.set(key, s); }
		return s;
	};
	return {
		async getStore(schemaName, tableName) { return get(`${schemaName}.${tableName}`); },
		async getIndexStore(schemaName, tableName, indexName) { return get(`${schemaName}.${tableName}_idx_${indexName}`); },
		async getStatsStore(schemaName, tableName) { return get(`${schemaName}.${tableName}.__stats__`); },
		async getCatalogStore() { return get('__catalog__'); },
		async closeStore() {},
		async closeIndexStore() {},
		async closeAll() {
			for (const store of stores.values()) await store.close();
			stores.clear();
		},
	};
}

/** First column of the first row, or null when the query yielded nothing. */
async function scalar(db: Database, sql: string): Promise<SqlValue> {
	const rows = await asyncIterableToArray(db.eval(sql)) as unknown as Record<string, SqlValue>[];
	if (rows.length === 0) return null;
	const values = Object.values(rows[0]);
	return values.length > 0 ? values[0] : null;
}

function recordedStats(db: Database, table: string): TableStatistics {
	const schema = db.schemaManager.findTable(table);
	expect(schema, `table ${table} should be registered`).to.exist;
	expect(schema!.statistics, `ANALYZE should have recorded statistics for ${table}`).to.exist;
	return schema!.statistics!;
}

/** `undefined` (no value seen) and SQL `null` (no row / all null) are the same fact here. */
function normalize(value: SqlValue | undefined): SqlValue {
	return value === undefined ? null : value;
}

async function expectStatisticsMatchData(
	db: Database,
	table: string,
	columns: readonly string[],
	label: string,
): Promise<void> {
	const stats = recordedStats(db, table);

	expect(stats.rowCount, `${label}: rowCount`).to.equal(await scalar(db, `select count(*) as c from ${table}`));

	for (const column of columns) {
		const recorded = stats.columnStats.get(column.toLowerCase());
		expect(recorded, `${label}: statistics recorded for column ${column}`).to.exist;

		expect(recorded!.nullCount, `${label}: ${column}.nullCount`)
			.to.equal(await scalar(db, `select count(*) as c from ${table} where ${column} is null`));
		expect(recorded!.distinctCount, `${label}: ${column}.distinctCount`)
			.to.equal(await scalar(db, `select count(distinct ${column}) as c from ${table}`));
		expect(normalize(recorded!.minValue), `${label}: ${column}.minValue`)
			.to.equal(await scalar(db, `select min(${column}) as m from ${table}`));
		expect(normalize(recorded!.maxValue), `${label}: ${column}.maxValue`)
			.to.equal(await scalar(db, `select max(${column}) as m from ${table}`));
	}
}

const COLUMNS = ['id', 'g', 'v', 'lo', 'somenull'] as const;

/** `t(id, g, v, lo, somenull)` — low/high cardinality, integer/text, some-null, one index. */
async function seed(db: Database, table: string, rowCount: number): Promise<void> {
	await db.exec(
		`create table ${table} (id integer primary key, g integer, v integer, lo text, somenull integer null) using store`,
	);
	await db.exec(`create index ${table}_g on ${table} (g)`);

	const BATCH = 250;
	for (let start = 1; start <= rowCount; start += BATCH) {
		const end = Math.min(start + BATCH - 1, rowCount);
		const tuples: string[] = [];
		for (let i = start; i <= end; i++) {
			tuples.push(`(${i}, ${i % 7}, ${i}, 'g${i % 5}', ${i % 3 === 0 ? 'null' : i})`);
		}
		await db.exec(`insert into ${table} values ${tuples.join(', ')}`);
	}
}

describe('ANALYZE records what the data contains (store backend)', () => {
	const open: KVStoreProvider[] = [];
	let db: Database | undefined;

	const start = async (): Promise<Database> => {
		const provider = createInMemoryProvider();
		open.push(provider);
		const database = new Database();
		database.registerModule('store', new StoreModule(provider));
		db = database;
		return database;
	};

	afterEach(async () => {
		await db?.close();
		db = undefined;
		while (open.length > 0) await open.pop()!.closeAll();
	});

	// 1200 is just past the 1000-value cap the memory backend's sampler used, so a shared
	// regression in the scan collector shows up here too.
	for (const rowCount of [12, 1200]) {
		it(`matches plain SQL over a ${rowCount}-row table`, async function () {
			this.timeout(60000);
			const database = await start();
			await seed(database, 't', rowCount);
			await database.exec('analyze t');
			await expectStatisticsMatchData(database, 't', COLUMNS, `${rowCount} rows`);
		});
	}

	it('records the in-transaction row count, not the committed base', async function () {
		this.timeout(60000);
		const database = await start();
		await seed(database, 'tx', 10);

		await database.exec('begin');
		const tuples: string[] = [];
		for (let i = 11; i <= 110; i++) tuples.push(`(${i}, ${i % 7}, ${i}, 'g${i % 5}', ${i % 3 === 0 ? 'null' : i})`);
		await database.exec(`insert into tx values ${tuples.join(', ')}`);

		expect(await scalar(database, 'select count(*) as c from tx'), 'the connection sees its own writes')
			.to.equal(110);

		await database.exec('analyze tx');
		await expectStatisticsMatchData(database, 'tx', COLUMNS, 'inside a transaction');

		await database.exec('rollback');
	});
});
