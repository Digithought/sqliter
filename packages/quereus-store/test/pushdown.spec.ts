/**
 * Predicate-pushdown tests for StoreModule.getBestAccessPlan.
 *
 * Regression: getBestAccessPlan must only mark range filters as `handled`
 * when they target the leading PK column, because the legacy access-path
 * planner only forwards range bounds for primaryKeyDefinition[0]. Marking a
 * non-leading PK range as handled would cause the residual predicate to be
 * silently dropped — particularly visible on tables without an explicit
 * PRIMARY KEY (where every column becomes a PK column).
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import {
	Database,
	asyncIterableToArray,
	IndexConstraintOp,
	type BestAccessPlanResult,
	type PredicateConstraint,
	type SqlValue,
} from '@quereus/quereus';
import {
	StoreModule,
	StoreTable,
	InMemoryKVStore,
	type KVStoreProvider,
	type IterateOptions,
	type KVEntry,
} from '../src/index.js';

/**
 * In-memory data store that tallies how many entries its `iterate` actually
 * yields. Lets a test prove a selective PK range SEEKS a narrow window rather
 * than full-scanning and post-filtering (both return identical rows, so only the
 * visit count distinguishes them).
 */
class CountingKVStore extends InMemoryKVStore {
	public iterateEntryCount = 0;
	public getCount = 0;
	public getManyCalls = 0;
	public getManyKeyCount = 0;
	override async *iterate(options?: IterateOptions): AsyncIterable<KVEntry> {
		for await (const entry of super.iterate(options)) {
			this.iterateEntryCount++;
			yield entry;
		}
	}
	override async get(key: Uint8Array): Promise<Uint8Array | undefined> {
		this.getCount++;
		return super.get(key);
	}
	// InMemoryKVStore.getMany delegates through this.get (defaultGetMany), so batched
	// keys ALSO land in getCount — assert round trips on getManyCalls, volumes on
	// getManyKeyCount, and total keys fetched on getCount.
	override getMany(keys: readonly Uint8Array[]): Promise<(Uint8Array | undefined)[]> {
		this.getManyCalls++;
		this.getManyKeyCount += keys.length;
		return super.getMany(keys);
	}
}

/**
 * Provider whose DATA stores are {@link CountingKVStore}s (recorded in the
 * supplied `dataStores` map, keyed `schema.table`); index/stats/catalog stores
 * stay plain so only data-row iteration is counted.
 */
function createCountingProvider(dataStores: Map<string, CountingKVStore>): KVStoreProvider {
	const auxStores = new Map<string, InMemoryKVStore>();
	const aux = (key: string): InMemoryKVStore => {
		let s = auxStores.get(key);
		if (!s) { s = new InMemoryKVStore(); auxStores.set(key, s); }
		return s;
	};
	return {
		async getStore(schemaName: string, tableName: string) {
			const key = `${schemaName}.${tableName}`;
			let s = dataStores.get(key);
			if (!s) { s = new CountingKVStore(); dataStores.set(key, s); }
			return s;
		},
		async getIndexStore(schemaName: string, tableName: string, indexName: string) {
			return aux(`${schemaName}.${tableName}_idx_${indexName}`);
		},
		async getStatsStore(schemaName: string, tableName: string) {
			return aux(`${schemaName}.${tableName}.__stats__`);
		},
		async getCatalogStore() {
			return aux('__catalog__');
		},
		async closeStore() {},
		async closeIndexStore() {},
		async closeAll() {
			for (const s of dataStores.values()) await s.close();
			for (const s of auxStores.values()) await s.close();
			dataStores.clear();
			auxStores.clear();
		},
	};
}

function createInMemoryProvider(): KVStoreProvider {
	const stores = new Map<string, InMemoryKVStore>();

	return {
		async getStore(schemaName: string, tableName: string) {
			const key = `${schemaName}.${tableName}`;
			if (!stores.has(key)) {
				stores.set(key, new InMemoryKVStore());
			}
			return stores.get(key)!;
		},
		async getIndexStore(schemaName: string, tableName: string, indexName: string) {
			const key = `${schemaName}.${tableName}_idx_${indexName}`;
			if (!stores.has(key)) {
				stores.set(key, new InMemoryKVStore());
			}
			return stores.get(key)!;
		},
		async getStatsStore(schemaName: string, tableName: string) {
			const key = `${schemaName}.${tableName}.__stats__`;
			if (!stores.has(key)) {
				stores.set(key, new InMemoryKVStore());
			}
			return stores.get(key)!;
		},
		async getCatalogStore() {
			const key = '__catalog__';
			if (!stores.has(key)) {
				stores.set(key, new InMemoryKVStore());
			}
			return stores.get(key)!;
		},
		async closeStore(_schemaName: string, _tableName: string) {},
		async closeIndexStore(_schemaName: string, _tableName: string, _indexName: string) {},
		async closeAll() {
			for (const store of stores.values()) {
				await store.close();
			}
			stores.clear();
		},
	};
}

describe('StoreModule predicate pushdown', () => {
	let db: Database;
	let provider: KVStoreProvider;
	let storeModule: StoreModule;

	beforeEach(() => {
		db = new Database();
		provider = createInMemoryProvider();
		storeModule = new StoreModule(provider);
		db.registerModule('store', storeModule);
	});

	afterEach(async () => {
		await provider.closeAll();
	});

	/** The `query_plan()` op names for `query`, as a JSON array string. */
	async function planOps(query: string): Promise<string> {
		const rows = await asyncIterableToArray(
			db.eval(`select json_group_array(op) as ops from query_plan(?)`, [query]),
		);
		expect(rows).to.have.lengthOf(1);
		return rows[0].ops as string;
	}

	/** The `query_plan()` `detail` strings for `query`, as a JSON array string. */
	async function planDetails(query: string): Promise<string> {
		const rows = await asyncIterableToArray(
			db.eval(`select json_group_array(detail) as details from query_plan(?)`, [query]),
		);
		expect(rows).to.have.lengthOf(1);
		return rows[0].details as string;
	}

	/**
	 * The `query_plan()` `properties` blobs for `query`, as a JSON array string. Carries
	 * `filterInfo.usableIndex` — the `idxStr` the planner handed the module — so a test can
	 * assert WHICH access arm fired, not merely that some seek did. Row assertions cannot:
	 * every arm returns the same rows, so a silently-lost narrowing is invisible from the
	 * outside.
	 */
	async function planProperties(query: string): Promise<string> {
		const rows = await asyncIterableToArray(
			db.eval(`select json_group_array(properties) as props from query_plan(?)`, [query]),
		);
		expect(rows).to.have.lengthOf(1);
		// `properties` is itself JSON, so the group array comes back as a parsed structure
		// rather than the text `detail` yields. Re-serialize so callers can regex it.
		const props = rows[0].props;
		return typeof props === 'string' ? props : JSON.stringify(props);
	}

	describe('explicit PRIMARY KEY (id)', () => {
		beforeEach(async () => {
			await db.exec(`
				create table users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER) using store
			`);
			await db.exec(`insert into users values (1, 'Alice', 30), (2, 'Bob', 25), (3, 'Carol', 35)`);
		});

		it('range on PK column id returns correct rows (range-scan path)', async () => {
			const rows = await asyncIterableToArray(db.eval(`select id, name from users where id > 1 order by id`));
			expect(rows).to.deep.equal([
				{ id: 2, name: 'Bob' },
				{ id: 3, name: 'Carol' },
			]);
		});

		it('range on non-PK column age returns correct rows (residual on full scan)', async () => {
			const rows = await asyncIterableToArray(db.eval(`select age, name from users where age > 25 order by age`));
			expect(rows).to.deep.equal([
				{ age: 30, name: 'Alice' },
				{ age: 35, name: 'Carol' },
			]);
		});
	});

	// Same positional-claim contract as `tryIndexAccessPlan`, but for the primary-key
	// branches of `computeBestAccessPlan`. The PK range branch over-claimed EVERY
	// same-op bound on the leading PK column, and the PK equality branch counted raw
	// '=' filters rather than DISTINCT pinned columns — so on a composite PK,
	// `a = 1 and a = 2` looked like a full key match, claimed both filters, found no
	// complete equality set to seek, and full-scanned with the residual already gone.
	describe('redundant same-column constraints on the primary key', () => {
		describe('single-column primary key', () => {
			const ids = async (q: string) =>
				(await asyncIterableToArray(db.eval(q))).map(r => r.id as number);

			beforeEach(async () => {
				await db.exec(`create table t (id integer primary key, v integer) using store`);
				await db.exec(`insert into t values (10, 1), (20, 2), (30, 3), (40, 4)`);
			});

			it('two lower bounds: the tighter one is not dropped', async () =>
				expect(await ids(`select id from t where id > 10 and id > 30 order by id`)).to.deep.equal([40]));

			it('two upper bounds: the tighter one is not dropped', async () =>
				expect(await ids(`select id from t where id < 40 and id < 20 order by id`)).to.deep.equal([10]));

			it('mixed same-side ops (> and >=) keep both', async () =>
				expect(await ids(`select id from t where id > 10 and id >= 30 order by id`)).to.deep.equal([30, 40]));

			it('contradictory equality pair yields no rows', async () =>
				expect(await ids(`select id from t where id = 20 and id = 30`)).to.deep.equal([]));

			it('a two-sided range still seeks and stays correct', async () => {
				expect(await ids(`select id from t where id > 10 and id < 40 order by id`)).to.deep.equal([20, 30]);
				expect(await planOps(`select id from t where id > 10 and id < 40`)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
			});
		});

		describe('composite primary key (a, b)', () => {
			beforeEach(async () => {
				await db.exec(`create table c (a integer not null, b integer not null, primary key (a, b)) using store`);
				await db.exec(`insert into c values (1, 1), (1, 2), (2, 1)`);
			});

			// Before the dedupe, this returned EVERY row in the table.
			it('contradictory equality pair on the leading key column yields no rows', async () =>
				expect(await asyncIterableToArray(db.eval(`select a, b from c where a = 1 and a = 2`))).to.deep.equal([]));

			it('a genuine full-key equality still finds its row', async () =>
				expect(await asyncIterableToArray(db.eval(`select a, b from c where a = 1 and b = 2`)))
					.to.deep.equal([{ a: 1, b: 2 }]));

			it('a redundant equality alongside a full key match keeps the residual', async () =>
				expect(await asyncIterableToArray(db.eval(`select a, b from c where a = 1 and b = 2 and a = 2`)))
					.to.deep.equal([]));

			// Only the leading key column is pinned — no full key match, so the plan falls
			// through to the PK range/scan arms and the equalities stay residual.
			it('a partial key equality still returns its rows', async () =>
				expect(await asyncIterableToArray(db.eval(`select a, b from c where a = 1 order by b`)))
					.to.deep.equal([{ a: 1, b: 1 }, { a: 1, b: 2 }]));
		});
	});

	describe('table without explicit PRIMARY KEY', () => {
		beforeEach(async () => {
			// No PK declared — every column becomes part of the implicit PK.
			await db.exec(`
				create table users (id INTEGER, name TEXT, age INTEGER) using store
			`);
			await db.exec(`insert into users values (1, 'Alice', 30), (2, 'Bob', 25), (3, 'Carol', 35)`);
		});

		it('range on first column id returns correct rows', async () => {
			const rows = await asyncIterableToArray(db.eval(`select id, name from users where id > 1 order by id`));
			expect(rows).to.deep.equal([
				{ id: 2, name: 'Bob' },
				{ id: 3, name: 'Carol' },
			]);
		});

		// Regression: under the old behavior, getBestAccessPlan would mark this
		// range as handled even though the legacy planner only forwards ranges
		// on the first PK column — so the predicate was silently dropped and
		// every row was returned.
		it('range on non-first column age returns correct rows', async () => {
			const rows = await asyncIterableToArray(db.eval(`select age, name from users where age > 25 order by age`));
			expect(rows).to.deep.equal([
				{ age: 30, name: 'Alice' },
				{ age: 35, name: 'Carol' },
			]);
		});

		it('compound predicate (range + LIKE) on non-first column returns correct rows', async () => {
			const rows = await asyncIterableToArray(db.eval(
				`select age, name from users where age > 25 and name like 'A%' order by age`
			));
			expect(rows).to.deep.equal([
				{ age: 30, name: 'Alice' },
			]);
		});
	});

	// Regression for `store-range-seek-collation-bounds`: the store advertises
	// `honorsCollatedRangeBounds` (its post-fetch row filter compares pushed range
	// bounds under the column's declared collation), so a collation-matched
	// non-BINARY PK range/BETWEEN now uses the index seek — and, because the MATCH
	// cover drops the residual Filter, StoreTable.compareValues alone must
	// reproduce the predicate's collation semantics.
	describe('collated PK range seek (store-range-seek-collation-bounds)', () => {
		async function values(query: string): Promise<unknown[]> {
			const rows = await asyncIterableToArray(db.eval(query));
			return rows.map(r => r.n);
		}

		describe('NOCASE primary key', () => {
			beforeEach(async () => {
				// NOCASE-distinct values whose BINARY order ('Banana','CHERRY','apple',
				// 'date') differs from NOCASE order — a BINARY bound filter under-fetches.
				await db.exec(`create table fruits (name text collate NOCASE primary key, n integer) using store`);
				await db.exec(`insert into fruits values ('apple', 1), ('Banana', 2), ('CHERRY', 3), ('date', 4)`);
			});

			it('range uses the PK seek and returns NOCASE-correct rows', async () => {
				const q = `select n from fruits where name > 'banana' order by n`;
				expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
				expect(await values(q)).to.deep.equal([3, 4]);
			});

			it('BETWEEN uses the PK seek and honours NOCASE on both bounds', async () => {
				const q = `select n from fruits where name between 'banana' and 'cherry' order by n`;
				expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
				expect(await values(q)).to.deep.equal([2, 3]);
			});

			it('collation-mismatched bound still declines to scan + residual', async () => {
				const q = `select n from fruits where name > 'banana' collate BINARY order by n`;
				const ops = await planOps(q);
				expect(ops).to.not.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
				expect(ops).to.match(/SEQSCAN|SEQ SCAN|SeqScan/i);
				// BINARY: only 'date' is greater than 'banana'.
				expect(await values(q)).to.deep.equal([4]);
			});
		});

		describe('RTRIM primary key', () => {
			beforeEach(async () => {
				await db.exec(`create table pets (val text collate RTRIM primary key, n integer) using store`);
				await db.exec(`insert into pets values ('ant', 1), ('cat ', 2), ('dog', 3)`);
			});

			it("> excludes the RTRIM-equal trailing-space variant", async () => {
				const q = `select n from pets where val > 'cat' order by n`;
				expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
				// 'cat ' RTRIM-equals 'cat' (a raw BINARY compare would over-fetch it).
				expect(await values(q)).to.deep.equal([3]);
			});

			it('>= with a trailing-space bound includes the RTRIM-equal row', async () => {
				const q = `select n from pets where val >= 'cat  ' order by n`;
				expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
				// A raw BINARY compare would under-fetch 'cat ' ('cat ' < 'cat  ' in bytes).
				expect(await values(q)).to.deep.equal([2, 3]);
			});

			it('point lookup matches the RTRIM-equal stored row', async () => {
				// The RTRIM key encoding maps 'cat' to the stored 'cat ' entry, so the
				// post-fetch EQ re-check in matchesFilters must also compare under RTRIM —
				// the old raw `a === b` EQ would have silently dropped the fetched row.
				expect(await values(`select n from pets where val = 'cat'`)).to.deep.equal([2]);
			});
		});

		describe('blob primary key point lookup', () => {
			it('EQ re-check compares blob content, not reference', async () => {
				// The point lookup fetches by key, then matchesFilters re-checks the EQ
				// constraint. The old raw `a === b` EQ compared Uint8Array references,
				// silently dropping every fetched blob row; compareSqlValues compares bytes.
				await db.exec(`create table blobs (b blob primary key, n integer) using store`);
				await db.exec(`insert into blobs values (x'0102', 1), (x'0103', 2)`);
				expect(await values(`select n from blobs where b = x'0102'`)).to.deep.equal([1]);
			});
		});

		// DESC + non-BINARY collation on the SAME leading PK column: buildPKRangeBounds
		// must apply BOTH the lower/upper byte-bound SWAP (DESC) and the NOCASE encoder
		// to each bound. A bug in either dimension under-fetches (missing rows).
		describe('DESC NOCASE primary key', () => {
			beforeEach(async () => {
				await db.exec(`create table dfruits (name text collate NOCASE primary key desc, n integer) using store`);
				await db.exec(`insert into dfruits values ('apple', 1), ('Banana', 2), ('CHERRY', 3), ('date', 4)`);
			});

			it('range seeks under both DESC and NOCASE and returns the correct rows', async () => {
				const q = `select n from dfruits where name > 'banana' order by n`;
				expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
				expect(await values(q)).to.deep.equal([3, 4]);
			});

			it('BETWEEN seeks under both DESC and NOCASE and honours both bounds', async () => {
				const q = `select n from dfruits where name between 'banana' and 'cherry' order by n`;
				expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
				expect(await values(q)).to.deep.equal([2, 3]);
			});
		});

		describe('explicit BINARY primary key (negative control)', () => {
			it('range seeks and keeps plain BINARY semantics', async () => {
				// Explicit BINARY so the store does not reconcile the PK column to its
				// NOCASE key-collation default.
				await db.exec(`create table bins (name text collate BINARY primary key, n integer) using store`);
				await db.exec(`insert into bins values ('Banana', 1), ('apple', 2), ('CHERRY', 3), ('date', 4)`);
				const q = `select n from bins where name > 'CHERRY' order by n`;
				expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
				// BINARY: uppercase sorts before lowercase, so 'apple' and 'date' qualify.
				expect(await values(q)).to.deep.equal([2, 4]);
			});
		});
	});

	// DESC leading PK: buildPKRangeBounds' lower/upper byte-bound assignment SWAPS
	// (a `>` seeks the smaller-bytes window). A wrong swap that under-fetches would
	// show up as missing rows here.
	describe('DESC leading primary key', () => {
		beforeEach(async () => {
			await db.exec(`create table d (id integer primary key desc, n integer) using store`);
			await db.exec(`insert into d values (1, 10), (2, 20), (3, 30), (4, 40)`);
		});

		it('> k seeks and returns the correct rows', async () => {
			const rows = await asyncIterableToArray(db.eval(`select n from d where id > 2 order by id`));
			expect(rows.map(r => r.n)).to.deep.equal([30, 40]);
		});

		it('between a and b seeks and returns the correct rows', async () => {
			const rows = await asyncIterableToArray(db.eval(`select n from d where id between 2 and 3 order by id`));
			expect(rows.map(r => r.n)).to.deep.equal([20, 30]);
		});
	});

	// Regression for `store-blob-key-varint-not-memcmp-ordered`: a BLOB primary key
	// must encode so its stored bytes sort element-by-element (matching SQL blob
	// comparison). The old length-prefix layout sorted a shorter blob before a
	// longer one regardless of content, so a leading-PK range seek silently dropped
	// qualifying rows the mis-ordered window skipped (matchesFilters can only
	// re-filter rows the seek already yielded — it cannot recover a skipped one).
	describe('blob primary key range seek (store-blob-key-varint-not-memcmp-ordered)', () => {
		// x'0102' < x'03' element-wise (0x01 < 0x03), yet a length-first byte layout
		// sorts the shorter x'03' (len 1) before x'0102' (len 2). x'0102ff' also
		// exercises prefix < extension (a proper prefix must sort before its
		// extensions). Ordered by b: x'0102'(1), x'0102ff'(3), x'03'(2).
		async function seedBlobs(name: string, using: string): Promise<void> {
			await db.exec(`create table ${name} (b blob primary key, n integer) ${using}`);
			await db.exec(`insert into ${name} values (x'0102', 1), (x'03', 2), (x'0102ff', 3)`);
		}

		it('ASC: b >= x\'0102\' matches the memory-vtab oracle (no under-fetch)', async () => {
			await seedBlobs('bstore', 'using store');
			await seedBlobs('bmem', ''); // default in-memory vtab = full-scan oracle
			const q = (t: string) => `select n from ${t} where b >= x'0102' order by b`;
			const storeRows = (await asyncIterableToArray(db.eval(q('bstore')))).map(r => r.n);
			const memRows = (await asyncIterableToArray(db.eval(q('bmem')))).map(r => r.n);
			// Oracle and store agree, and both equal the element-wise order.
			expect(memRows).to.deep.equal([1, 3, 2]);
			expect(storeRows).to.deep.equal(memRows);
		});

		it('ASC: b > x\'0102\' excludes the equal blob', async () => {
			await seedBlobs('bstore2', 'using store');
			const rows = await asyncIterableToArray(db.eval(`select n from bstore2 where b > x'0102' order by b`));
			expect(rows.map(r => r.n)).to.deep.equal([3, 2]);
		});

		// DESC blob PK: encodeCompositeKey bit-inverts each component's bytes; the
		// variable-length + terminator scheme must stay order-correct under inversion.
		it('DESC: b >= x\'0102\' seeks under inversion and returns correct rows', async () => {
			await db.exec(`create table bdesc (b blob primary key desc, n integer) using store`);
			await db.exec(`insert into bdesc values (x'0102', 1), (x'03', 2), (x'0102ff', 3)`);
			const rows = await asyncIterableToArray(db.eval(`select n from bdesc where b >= x'0102' order by b desc`));
			// order by b desc: x'03'(2), x'0102ff'(3), x'0102'(1)
			expect(rows.map(r => r.n)).to.deep.equal([2, 3, 1]);
		});
	});

	// Regression for `store-numeric-key-mixed-int-real-sort-order`: a numeric primary
	// key that mixes whole and fractional values must encode so its stored bytes sort
	// by numeric VALUE, not by JS runtime shape. The old per-shape TYPE_INTEGER(0x01) <
	// TYPE_REAL(0x02) tag made every whole number sort below every fractional one, so a
	// leading-PK range seek built a byte window that skipped qualifying whole numbers
	// the mis-ordered layout placed outside it (matchesFilters can only re-filter rows
	// the seek already yielded — it cannot recover a skipped one).
	describe('numeric primary key mixed int/real range seek (store-numeric-key-mixed-int-real-sort-order)', () => {
		// Whole numbers (2, 3) interleave with fractional (2.5, 3.5); the whole ones
		// must NOT all sort before the fractional ones. Ordered by x: 2, 2.5, 3, 3.5.
		async function seedNums(name: string, using: string): Promise<void> {
			await db.exec(`create table ${name} (x real primary key, n integer) ${using}`);
			await db.exec(`insert into ${name} values (2, 20), (2.5, 25), (3, 30), (3.5, 35)`);
		}

		it("ASC: x >= 2.5 matches the memory-vtab oracle (no under-fetch)", async () => {
			await seedNums('nstore', 'using store');
			await seedNums('nmem', ''); // default in-memory vtab = full-scan oracle
			const q = (t: string) => `select n from ${t} where x >= 2.5 order by x`;
			const storeRows = (await asyncIterableToArray(db.eval(q('nstore')))).map(r => r.n);
			const memRows = (await asyncIterableToArray(db.eval(q('nmem')))).map(r => r.n);
			expect(memRows).to.deep.equal([25, 30, 35]); // 2.5, 3, 3.5 — includes whole 3
			expect(storeRows).to.deep.equal(memRows);     // FAILS pre-fix: store drops n=30
		});

		it('BETWEEN spanning the int/real boundary matches the oracle', async () => {
			await seedNums('nstore2', 'using store');
			await seedNums('nmem2', '');
			const q = (t: string) => `select n from ${t} where x between 2.5 and 3 order by x`;
			const storeRows = (await asyncIterableToArray(db.eval(q('nstore2')))).map(r => r.n);
			const memRows = (await asyncIterableToArray(db.eval(q('nmem2')))).map(r => r.n);
			expect(memRows).to.deep.equal([25, 30]); // 2.5, 3
			expect(storeRows).to.deep.equal(memRows);
		});

		// DESC numeric PK: encodeCompositeKey bit-inverts the whole 17-byte component;
		// the fixed-width layout must stay order-correct under inversion.
		it('DESC: x >= 2.5 seeks under inversion and matches the oracle', async () => {
			await db.exec(`create table ndesc (x real primary key desc, n integer) using store`);
			await db.exec(`insert into ndesc values (2, 20), (2.5, 25), (3, 30), (3.5, 35)`);
			const rows = await asyncIterableToArray(db.eval(`select n from ndesc where x >= 2.5 order by x desc`));
			// order by x desc: 3.5(35), 3(30), 2.5(25)
			expect(rows.map(r => r.n)).to.deep.equal([35, 30, 25]);
		});

	});

	// Regression / gap-closer for `debt-bigint-pk-store-range-seek-test`: an
	// end-to-end SQL range seek over an integer PK >= 2^53 through the persistent
	// store path. The upstream change-log crash on a bigint PK (serializeKeyTuple
	// -> canonicalJsonString -> JSON.stringify) was fixed under
	// txn-changelog-bigint-key (the change log now keys via the reversible
	// key-tuple-codec, see util/key-tuple-codec.ts), which unblocked writing this
	// test. The STORE byte encoding of large ints is proven separately at the unit
	// level in encoding.spec.ts (sort order + exact roundtrip across the
	// shared-double boundary); this test closes the gap by exercising the full
	// INSERT -> range-SELECT path against the store module.
	describe('bigint primary key range seek (debt-bigint-pk-store-range-seek-test)', () => {
		// 2^53 + 1 — the smallest positive integer that cannot be represented
		// exactly as a JS number, so it must flow as a bigint end-to-end. A lossy
		// `number` cast would collapse it (and the next row's key) to 2^53.
		const BIG = 9007199254740993n; // 2^53 + 1

		async function seed(name: string, using: string): Promise<void> {
			await db.exec(`create table ${name} (id integer primary key, v integer) ${using}`);
			await db.exec(
				`insert into ${name} values `
				+ `(${(-BIG - 1n).toString()}, 5), (${(-BIG).toString()}, 6), `
				+ `(1, 10), (2, 20), (${BIG.toString()}, 30), (${(BIG + 1n).toString()}, 40)`,
			);
		}

		it('range seek over a bigint PK matches the memory-vtab oracle, in order, with exact values', async () => {
			await seed('bigstore', 'using store');
			await seed('bigmem', ''); // default in-memory vtab = full-scan oracle

			const q = (t: string) => `select id, v from ${t} where id >= ${BIG.toString()} order by id`;
			const storeRows = await asyncIterableToArray(db.eval(q('bigstore')));
			const memRows = await asyncIterableToArray(db.eval(q('bigmem')));

			expect(memRows).to.deep.equal([
				{ id: BIG, v: 30 },
				{ id: BIG + 1n, v: 40 },
			]);
			expect(storeRows).to.deep.equal(memRows);
			expect(typeof storeRows[0].id).to.equal('bigint');
		});

		it('an exclusive bound at 2^53+1 excludes only that row', async () => {
			await seed('bigstore3', 'using store');
			await seed('bigmem3', '');
			const q = (t: string) => `select id from ${t} where id > ${BIG.toString()} order by id`;
			const storeRows = await asyncIterableToArray(db.eval(q('bigstore3')));
			// A bound rounded through a double would compare equal to BIG's neighbour
			// and let the excluded row through.
			expect(storeRows).to.deep.equal([{ id: BIG + 1n }]);
			expect(storeRows).to.deep.equal(await asyncIterableToArray(db.eval(q('bigmem3'))));
		});

		// Sign flips the key's byte layout; a scheme that only stayed order-correct
		// above zero would mis-order the two magnitudes past -2^53 here.
		it('a range seek below -2^53 matches the oracle, in order, with exact values', async () => {
			await seed('bigstore4', 'using store');
			await seed('bigmem4', '');
			const q = (t: string) => `select id, v from ${t} where id <= ${(-BIG).toString()} order by id`;
			const storeRows = await asyncIterableToArray(db.eval(q('bigstore4')));

			expect(storeRows).to.deep.equal([
				{ id: -BIG - 1n, v: 5 },
				{ id: -BIG, v: 6 },
			]);
			expect(storeRows).to.deep.equal(await asyncIterableToArray(db.eval(q('bigmem4'))));
			expect(typeof storeRows[0].id).to.equal('bigint');
		});

		it('the range seek uses the index-seek path, not a full scan', async () => {
			await seed('bigstore2', 'using store');
			const ops = await planOps(`select id from bigstore2 where id >= ${BIG.toString()} order by id`);
			expect(ops).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
			expect(ops).to.not.match(/SEQSCAN|SEQ SCAN|SeqScan/i);
		});
	});

	// Every PK key collation reaching `buildPKRangeBounds` has a key normalizer:
	// `StoreTable`'s constructor rejects one that cannot key a persisted structure
	// (`no such collation sequence` / `cannot key a persisted structure`), so there is
	// no longer a "comparator-only" branch to fall back from. The window it derives is
	// still only a SUPERSET — `matchesFilters` stays the authoritative row filter.
	describe('buildPKRangeBounds narrows under a resolvable key collation', () => {
		// Structural view of the protected surface under test.
		interface RangeBoundsProbe {
			pkKeyCollations: (string | undefined)[];
			buildPKRangeBounds(access: {
				type: 'range';
				columnIndex: number;
				constraints: Array<{ columnIndex: number; op: IndexConstraintOp; value?: SqlValue }>;
			}): IterateOptions;
		}

		const gtBananaBounds = (table: StoreTable): IterateOptions =>
			(table as unknown as RangeBoundsProbe).buildPKRangeBounds({
				type: 'range',
				columnIndex: 0,
				constraints: [{ columnIndex: 0, op: IndexConstraintOp.GT, value: 'banana' }],
			});

		it('a NOCASE text PK narrows to a non-empty lower bound', async () => {
			await db.exec(`create table plain (name text collate NOCASE primary key, n integer) using store`);
			const table = storeModule.getTable('main', 'plain');
			expect(table).to.exist;

			const bounds = gtBananaBounds(table!);
			expect(bounds.gte, 'NOCASE PK should seek to a lower bound').to.exist;
			expect(bounds.gte!.length, 'NOCASE PK should seek to a non-empty lower bound').to.be.greaterThan(0);
		});

		it('an unresolvable key collation is rejected at CREATE TABLE, not at seek time', async () => {
			let error: Error | null = null;
			try {
				await db.exec(`create table sorted (name text primary key) using store (collation = 'CUSTOMSORT')`);
			} catch (e) {
				error = e as Error;
			}
			expect(error, 'expected CREATE TABLE to reject the unresolvable key collation').to.not.be.null;
			expect(error!.message).to.match(/CUSTOMSORT/);
		});
	});

	// Distinguish a real seek from full-scan + filter: only the latter visits every
	// row. Uses a CountingKVStore data store and asserts the visit count.
	describe('window narrowing (real seek, not full-scan + filter)', () => {
		let cdb: Database;
		let cprovider: KVStoreProvider;
		let dataStores: Map<string, CountingKVStore>;

		async function seed(table: string, pkClause: string): Promise<CountingKVStore> {
			await cdb.exec(`create table ${table} (id integer primary key ${pkClause}, n integer) using store`);
			const vals = Array.from({ length: 100 }, (_, i) => `(${i}, ${i})`).join(', ');
			await cdb.exec(`insert into ${table} values ${vals}`);
			const store = dataStores.get(`main.${table}`);
			expect(store, `data store for ${table} should exist`).to.exist;
			store!.iterateEntryCount = 0;
			return store!;
		}

		beforeEach(() => {
			dataStores = new Map();
			cprovider = createCountingProvider(dataStores);
			cdb = new Database();
			cdb.registerModule('store', new StoreModule(cprovider));
		});

		afterEach(async () => {
			await cprovider.closeAll();
		});

		it('a selective ASC range visits far fewer entries than the full row count', async () => {
			const store = await seed('nums', '');
			const rows = await asyncIterableToArray(cdb.eval(`select n from nums where id > 95 order by id`));
			expect(rows.map(r => r.n)).to.deep.equal([96, 97, 98, 99]);
			// Seek lands just past id=95 and early-terminates: ~4 entries visited, not
			// 100. A full-scan + post-filter implementation would visit all 100.
			expect(store.iterateEntryCount, 'seek should visit only the in-window slice').to.be.lessThanOrEqual(5);
		});

		it('a selective DESC range narrows (proves the swap over-fetches nothing)', async () => {
			const store = await seed('dnums', 'desc');
			const rows = await asyncIterableToArray(cdb.eval(`select n from dnums where id > 95 order by id`));
			expect(rows.map(r => r.n)).to.deep.equal([96, 97, 98, 99]);
			// DESC `> 95` seeks the lt = lo(95) window (smaller bytes ⇒ larger values).
			expect(store.iterateEntryCount, 'DESC seek should visit only the in-window slice').to.be.lessThanOrEqual(5);
		});

		it('an empty / contradictory window yields no rows without error', async () => {
			const store = await seed('nums', '');
			const rows = await asyncIterableToArray(cdb.eval(`select n from nums where id > 10 and id < 5`));
			expect(rows).to.deep.equal([]);
			// gte > lt ⇒ the KVStore iterate yields nothing; no throw, no visits.
			expect(store.iterateEntryCount).to.equal(0);
		});

		it('a `timespan` PK range visits only the elapsed-time window', async () => {
			// The re-opened semantic-ordering range window (semanticKeyOrderIsFaithful):
			// the bound encodes through the total-seconds transform, so the seek lands
			// inside the elapsed-time window rather than full-scanning + re-filtering.
			await cdb.exec(`create table ts (d timespan primary key) using store`);
			const vals = Array.from({ length: 60 }, (_, i) => `('PT${i + 1}M')`).join(', ');
			await cdb.exec(`insert into ts values ${vals}`);
			const store = dataStores.get('main.ts')!;
			store.iterateEntryCount = 0;

			const rows = await asyncIterableToArray(cdb.eval(`select d from ts where d > 'PT57M'`));
			expect(rows.map(r => r.d)).to.deep.equal(['PT58M', 'PT59M', 'PT60M']);
			expect(store.iterateEntryCount, 'seek should visit only the in-window slice').to.be.lessThanOrEqual(4);
		});

		it('a `json` PK range narrows to the structural window', async () => {
			// The JSON arm of the same re-open: the bound encodes through the structural
			// byte form (number tag + sortable double), so a numeric-JSON window seeks
			// instead of visiting every entry. A `json(…)`-valued bound is what makes the
			// window selective — a bare text literal is TEXT-class and ranks above every
			// number, so it would leave the window at the whole numeric region.
			await cdb.exec(`create table js (j json primary key) using store`);
			const vals = Array.from({ length: 60 }, (_, i) => `('${i}')`).join(', ');
			await cdb.exec(`insert into js values ${vals}`);
			const store = dataStores.get('main.js')!;
			store.iterateEntryCount = 0;

			const rows = await asyncIterableToArray(
				cdb.eval(`select json_quote(j) as q from js where j > json('57')`),
			);
			expect(rows.map(r => r.q)).to.deep.equal(['58', '59']);
			expect(store.iterateEntryCount, 'seek should visit only the in-window slice').to.be.lessThanOrEqual(3);
		});

		it('an empty `timespan` window yields no rows without scanning past it', async () => {
			await cdb.exec(`create table ts2 (d timespan primary key) using store`);
			await cdb.exec(`insert into ts2 values ('PT1M'), ('PT2M'), ('PT3M')`);
			const store = dataStores.get('main.ts2')!;
			store.iterateEntryCount = 0;

			const rows = await asyncIterableToArray(cdb.eval(`select d from ts2 where d > 'PT5M'`));
			expect(rows).to.deep.equal([]);
			expect(store.iterateEntryCount, 'the window starts past every key').to.equal(0);
		});

		it('a `timespan` PK equality is one point read, not a window and not a scan', async () => {
			// The re-opened point arm (feat-store-semantic-key-point-seeks): a full-PK
			// equality resolves through `readLiveRowByPk`, which `get`s one key and never
			// iterates. The pre-re-open behaviour was a full scan (60 iterated entries).
			await cdb.exec(`create table ts3 (d timespan primary key) using store`);
			const vals = Array.from({ length: 60 }, (_, i) => `('PT${i + 1}M')`).join(', ');
			await cdb.exec(`insert into ts3 values ${vals}`);
			const store = dataStores.get('main.ts3')!;
			store.iterateEntryCount = 0;
			store.getCount = 0;

			// Bound and stored value are different spellings of one hour.
			const rows = await asyncIterableToArray(cdb.eval(`select d from ts3 where d = 'PT3600S'`));
			expect(rows.map(r => r.d)).to.deep.equal(['PT60M']);
			expect(store.iterateEntryCount, 'a point read iterates nothing').to.equal(0);
			expect(store.getCount, 'exactly one key is fetched').to.equal(1);
		});

		it('a `json` PK equality is one point read, reorder-equal spelling included', async () => {
			await cdb.exec(`create table js2 (j json primary key) using store`);
			const vals = Array.from({ length: 60 }, (_, i) => `('{"a":${i},"b":0}')`).join(', ');
			await cdb.exec(`insert into js2 values ${vals}`);
			const store = dataStores.get('main.js2')!;
			store.iterateEntryCount = 0;
			store.getCount = 0;

			const rows = await asyncIterableToArray(
				cdb.eval(`select json_quote(j) as q from js2 where j = json('{"b":0,"a":57}')`),
			);
			expect(rows.map(r => r.q)).to.deep.equal(['{"a":57,"b":0}']);
			expect(store.iterateEntryCount, 'a point read iterates nothing').to.equal(0);
			expect(store.getCount, 'exactly one key is fetched').to.equal(1);
		});

		it('an unfaithful `timespan` EQ probe declines the point arm rather than seeking a bogus key', async () => {
			// `d = 5` would encode to the NUMERIC(5) key — which 'PT5S' really occupies —
			// so the decline is not observable in the ROW set (the residual rejects the row
			// under the storage-class mismatch either way). The visit counts are what
			// distinguish "declined to a scan" from "seeked a key the probe has no
			// faithful position at".
			await cdb.exec(`create table ts4 (d timespan primary key) using store`);
			await cdb.exec(`insert into ts4 values ('PT5S'), ('PT2H'), ('PT30M')`);
			const store = dataStores.get('main.ts4')!;
			store.iterateEntryCount = 0;
			store.getCount = 0;

			expect(await asyncIterableToArray(cdb.eval(`select d from ts4 where d = 5`))).to.deep.equal([]);
			expect(store.iterateEntryCount, 'the arm declined to a full scan').to.equal(3);
			expect(store.getCount, 'no point read was issued').to.equal(0);
		});

		it('reads-own-writes: an uncommitted row inside the window surfaces', async () => {
			await seed('nums', '');
			await cdb.exec('begin');
			await cdb.exec(`insert into nums values (200, 200)`);
			await cdb.exec(`update nums set n = 970 where id = 97`);
			const rows = await asyncIterableToArray(cdb.eval(`select n from nums where id > 95 order by id`));
			await cdb.exec('commit');
			// 96, 97(updated→970), 98, 99, 200(pending insert) — all within id>95.
			expect(rows.map(r => r.n)).to.deep.equal([96, 970, 98, 99, 200]);
		});
	});

	// Secondary-index scan arm (store-index-scan-read-primitive): StoreTable.query
	// derives an encoded window over the chosen secondary index and resolves each
	// entry to its base row, and getBestAccessPlan advertises the index with
	// honestly-handled filters — subject to the collation-safety guard.
	describe('secondary-index scan (store-index-scan-read-primitive)', () => {
		it('EQ on an indexed non-text column seeks the index and returns correct rows', async () => {
			await db.exec(`create table t (id integer primary key, name text, age integer) using store`);
			await db.exec(`create index ix_age on t (age)`);
			await db.exec(`insert into t values (1, 'Alice', 30), (2, 'Bob', 25), (3, 'Carol', 30)`);

			const q = `select id from t where age = 30 order by id`;
			expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
			expect(await asyncIterableToArray(db.eval(q))).to.deep.equal([{ id: 1 }, { id: 3 }]);
		});

		it('range on an indexed non-text column seeks the index and returns correct rows', async () => {
			await db.exec(`create table t (id integer primary key, name text, age integer) using store`);
			await db.exec(`create index ix_age on t (age)`);
			await db.exec(`insert into t values (1, 'Alice', 30), (2, 'Bob', 25), (3, 'Carol', 35)`);

			const q = `select id from t where age > 25 order by age`;
			expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
			expect(await asyncIterableToArray(db.eval(q))).to.deep.equal([{ id: 1 }, { id: 3 }]);
		});

		it('text EQ on a NOCASE column (declared == K) seeks and matches case-insensitively', async () => {
			// The column is declared COLLATE NOCASE so matchesFilters compares under
			// NOCASE, matching the store's default key collation K = NOCASE (declared ==
			// K → collation-safe seek). Without the explicit COLLATE the column would be
			// BINARY and `= 'alice'` would match nothing (a distinct, correct behavior).
			await db.exec(`create table t (id integer primary key, name text collate nocase) using store`);
			await db.exec(`create index ix_name on t (name)`);
			await db.exec(`insert into t values (1, 'Alice'), (2, 'bob'), (3, 'ALICE')`);

			const q = `select id from t where name = 'alice' order by id`;
			expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
			expect(await asyncIterableToArray(db.eval(q))).to.deep.equal([{ id: 1 }, { id: 3 }]);
		});

		it('composite index: full-prefix EQ and leading-only EQ both return correct rows', async () => {
			await db.exec(`create table t (id integer primary key, a integer, b integer) using store`);
			await db.exec(`create index ix_ab on t (a, b)`);
			await db.exec(`insert into t values (1, 5, 10), (2, 5, 20), (3, 6, 10)`);

			// Full prefix (a, b) → single-entry point.
			const q1 = `select id from t where a = 5 and b = 20`;
			expect(await planOps(q1)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
			expect(await asyncIterableToArray(db.eval(q1))).to.deep.equal([{ id: 2 }]);

			// Leading column only → prefix window over both a = 5 rows.
			const q2 = `select id from t where a = 5 order by id`;
			expect(await planOps(q2)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
			expect(await asyncIterableToArray(db.eval(q2))).to.deep.equal([{ id: 1 }, { id: 2 }]);
		});

		it('DESC index column seeks under byte inversion and returns correct rows', async () => {
			await db.exec(`create table t (id integer primary key, v integer) using store`);
			await db.exec(`create index ix_v on t (v desc)`);
			await db.exec(`insert into t values (1, 10), (2, 20), (3, 30)`);

			const q = `select id from t where v > 15 order by v`;
			expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
			expect(await asyncIterableToArray(db.eval(q))).to.deep.equal([{ id: 2 }, { id: 3 }]);
		});

		it('a partial index is NOT chosen for a seek (no predicate-implication check); rows stay correct', async () => {
			await db.exec(`create table t (id integer primary key, v integer) using store`);
			await db.exec(`create index ix_pos on t (v) where v > 0`);
			await db.exec(`insert into t values (1, 10), (2, 20), (3, -5)`);

			// A partial index physically omits out-of-scope rows; since nothing checks
			// that the query's WHERE implies the index predicate, the store must NOT seek
			// it (it would drop rows an out-of-scope query needs). It full-scans +
			// residual instead — no index seek, correct rows.
			const inScope = `select id from t where v = 20`;
			expect(await planOps(inScope), 'partial index not chosen for a seek').to.not.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
			expect(await asyncIterableToArray(db.eval(inScope))).to.deep.equal([{ id: 2 }]);

			// An out-of-scope query (needs the row the partial index omits) is correct.
			const outScope = `select id from t where v = -5`;
			expect(await asyncIterableToArray(db.eval(outScope))).to.deep.equal([{ id: 3 }]);
		});

		// The table key collation K is no longer part of the index seek decision
		// (store-index-collation-guard-collapse): index bytes encode under the index
		// column's own collation, which for a NOCASE-declared column is NOCASE whatever K
		// is. Window and residual agree, so the seek is admitted and the answer stays
		// NOCASE-correct — this shape used to decline purely because K = BINARY.
		it('index over a NOCASE column of a K=BINARY store seeks, and stays NOCASE-correct', async () => {
			await db.exec(`create table t (id integer primary key, v text collate nocase) using store (collation = binary)`);
			await db.exec(`create index ix_v on t (v)`);
			await db.exec(`insert into t values (1, 'Apple'), (2, 'apple'), (3, 'Banana')`);

			const q = `select id from t where v = 'apple' order by id`;
			expect(await planOps(q), 'window and residual agree — the seek is claimed').to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
			// NOCASE-correct: both 'Apple' and 'apple' match.
			expect(await asyncIterableToArray(db.eval(q))).to.deep.equal([{ id: 1 }, { id: 2 }]);
		});

		// ANY carries no `isTextual` marker and a NULL physicalType, yet its `parse` is the
		// identity — so it stores text as text. Since `ANY_TYPE.compare` honors the
		// collation it is handed (any-type-compare-honors-collation), the index key bytes
		// encode under the declared NOCASE — the same collation the scan residual compares
		// under — so the byte-equality window IS the qualifying set and the seek is
		// admitted. The invariant stays what it always was: creating an index must never
		// change a query's results.
		it('index over an ANY column with a declared COLLATE seeks and stays correct', async () => {
			await db.exec(`create table t (id integer primary key, x ANY collate nocase) using store (collation = binary)`);
			await db.exec(`insert into t values (1, 'Bob')`);

			const q = `select id from t where x = 'BOB' order by id`;
			// Pin the no-index answer first: it is the oracle the indexed plan must match.
			expect(await asyncIterableToArray(db.eval(q)), 'NOCASE-equal row matches with no index').to.deep.equal([{ id: 1 }]);

			await db.exec(`create index ix_x on t (x)`);
			expect(await asyncIterableToArray(db.eval(q)), 'and still matches once an index exists').to.deep.equal([{ id: 1 }]);
			expect(await planOps(q), 'key and residual collation agree — the seek is claimed')
				.to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
		});

		// Regression: `tryIndexAccessPlan` must mark handled ONLY the constraints
		// rule-select-access-path actually consumes — per seek column the FIRST '=', or
		// the FIRST lower and FIRST upper bound (its `colConstraints.find(...)` picks by
		// position). That rule collapses handledFilters into a per-COLUMN set, so a
		// redundant same-column, same-side constraint marked handled is neither seeked
		// nor retained as a residual: its predicate vanishes and the query silently
		// returns the looser bound's rows. Each case below returned extra rows before
		// the positional claim in `tryIndexAccessPlan`.
		describe('redundant same-column constraints keep their predicate', () => {
			const ids = async (q: string) =>
				(await asyncIterableToArray(db.eval(q))).map(r => r.id as number);

			beforeEach(async () => {
				await db.exec(`create table t (id integer primary key, v integer) using store`);
				await db.exec(`create index ix_v on t (v)`);
				await db.exec(`insert into t values (1, 10), (2, 20), (3, 30), (4, 40)`);
			});

			it('two lower bounds: the tighter one is not dropped', async () =>
				expect(await ids(`select id from t where v > 10 and v > 30 order by id`)).to.deep.equal([4]));

			it('two upper bounds: the tighter one is not dropped', async () =>
				expect(await ids(`select id from t where v < 40 and v < 20 order by id`)).to.deep.equal([1]));

			it('mixed same-side ops (> and >=) keep both', async () =>
				expect(await ids(`select id from t where v > 10 and v >= 30 order by id`)).to.deep.equal([3, 4]));

			it('contradictory equality pair yields no rows', async () =>
				expect(await ids(`select id from t where v = 20 and v = 30`)).to.deep.equal([]));

			it('equality plus a contradicting range yields no rows', async () =>
				expect(await ids(`select id from t where v = 30 and v > 35`)).to.deep.equal([]));

			it('a two-sided range still seeks and stays correct', async () => {
				expect(await ids(`select id from t where v > 10 and v < 40 order by id`)).to.deep.equal([2, 3]);
				expect(await planOps(`select id from t where v > 10 and v < 40`)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
			});
		});

		// The encoded index window maps LT/LE/GT/GE onto gte/lt with a lower/upper SWAP
		// for a DESC column (bit-inverted bytes ⇒ larger value, smaller bytes). Exercise
		// every arm of that table in both directions — a single-op test cannot catch a
		// swapped assignment.
		for (const dir of ['asc', 'desc'] as const) {
			describe(`range-bound matrix on a ${dir.toUpperCase()} index column`, () => {
				const ids = async (q: string) =>
					(await asyncIterableToArray(db.eval(q))).map(r => r.id as number);

				beforeEach(async () => {
					await db.exec(`create table t (id integer primary key, v integer null) using store`);
					await db.exec(`create index ix_v on t (v ${dir})`);
					await db.exec(`insert into t values (1, 10), (2, 20), (3, 30), (4, 40), (5, 20)`);
				});

				it('GT', async () => expect(await ids(`select id from t where v > 20 order by id`)).to.deep.equal([3, 4]));
				it('GE', async () => expect(await ids(`select id from t where v >= 20 order by id`)).to.deep.equal([2, 3, 4, 5]));
				it('LT', async () => expect(await ids(`select id from t where v < 30 order by id`)).to.deep.equal([1, 2, 5]));
				it('LE', async () => expect(await ids(`select id from t where v <= 20 order by id`)).to.deep.equal([1, 2, 5]));

				it('two-sided inclusive and exclusive windows', async () => {
					expect(await ids(`select id from t where v >= 20 and v <= 30 order by id`)).to.deep.equal([2, 3, 5]);
					expect(await ids(`select id from t where v > 10 and v < 40 order by id`)).to.deep.equal([2, 3, 5]);
				});

				it('an empty window yields no rows', async () =>
					expect(await ids(`select id from t where v > 40`)).to.deep.equal([]));

				it('NULLs never satisfy a range bound', async () => {
					await db.exec(`insert into t values (6, null)`);
					expect(await ids(`select id from t where v > 5 order by id`)).to.deep.equal([1, 2, 3, 4, 5]);
					expect(await ids(`select id from t where v < 100 order by id`)).to.deep.equal([1, 2, 3, 4, 5]);
				});
			});

			it(`text range bounds on a ${dir.toUpperCase()} NOCASE index column`, async () => {
				await db.exec(`create table t (id integer primary key, s text collate nocase) using store`);
				await db.exec(`create index ix_s on t (s ${dir})`);
				await db.exec(`insert into t values (1, 'apple'), (2, 'Banana'), (3, 'cherry'), (4, 'date')`);
				const ids = async (q: string) =>
					(await asyncIterableToArray(db.eval(q))).map(r => r.id as number);

				expect(await ids(`select id from t where s > 'banana' order by id`)).to.deep.equal([3, 4]);
				expect(await ids(`select id from t where s >= 'Banana' order by id`)).to.deep.equal([2, 3, 4]);
				expect(await ids(`select id from t where s < 'cherry' order by id`)).to.deep.equal([1, 2]);
				expect(await ids(`select id from t where s <= 'CHERRY' order by id`)).to.deep.equal([1, 2, 3]);
			});
		}

		it('composite index (a asc, b desc): prefix EQ, trailing range, and leading range', async () => {
			await db.exec(`create table t (id integer primary key, a integer, b integer) using store`);
			await db.exec(`create index ix_ab on t (a asc, b desc)`);
			await db.exec(`insert into t values (1, 5, 10), (2, 5, 20), (3, 6, 10), (4, 5, 30)`);
			const ids = async (q: string) =>
				(await asyncIterableToArray(db.eval(q))).map(r => r.id as number);

			expect(await ids(`select id from t where a = 5 and b = 20`)).to.deep.equal([2]);
			expect(await ids(`select id from t where a = 5 order by id`)).to.deep.equal([1, 2, 4]);
			expect(await ids(`select id from t where a = 5 and b > 15 order by id`)).to.deep.equal([2, 4]);
			expect(await ids(`select id from t where a > 5 order by id`)).to.deep.equal([3]);
		});

		// Prefix-equality + trailing-range seek (`plan=7`). `a = ? and b < ?` over an index
		// on `(a, b)` used to seek only the `a` prefix and re-filter every entry under it;
		// it now seeks `prefix || bound`. Correctness was never at stake (the residual was
		// retained), so every case below asserts ROWS as well as the plan, and the last two
		// prove the window actually narrowed and that the degraded paths still widen.
		describe('prefix-equality + trailing-range seek', () => {
			const ids = async (q: string) =>
				(await asyncIterableToArray(db.eval(q))).map(r => r.id as number);

			describe('ASC trailing column', () => {
				beforeEach(async () => {
					await db.exec(`create table t (id integer primary key, a integer, b integer) using store`);
					await db.exec(`create index ix_ab on t (a, b)`);
					await db.exec(`insert into t values
						(1, 5, 10), (2, 5, 20), (3, 5, 30), (4, 5, 40),
						(5, 6, 20), (6, 6, 30)`);
				});

				it('picks the index seek, not a scan', async () => {
					const ops = await planOps(`select id from t where a = 5 and b >= 20 and b <= 30`);
					expect(ops).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
					expect(ops).to.not.match(/SEQSCAN|SEQ SCAN|SeqScan/i);
				});

				// The arm itself, not just "a seek happened": falling back to the plain prefix
				// seek (`plan=2`) answers every row assertion in this describe identically, so
				// the idxStr is the only thing that tells the two apart.
				it('hands the module a prefixRangeSeek idxStr, not a plain prefix seek', async () => {
					expect(await planProperties(`select id from t where a = 5 and b >= 20 and b <= 30`))
						.to.match(/idx=ix_ab\(0\);plan=7;prefixLen=1/);
				});

				// A DEGRADED arm must be visible too: the second lower bound is unclaimed, but
				// the plan is still the prefix-range one.
				it('redundant same-side bounds keep the prefixRangeSeek arm', async () => {
					expect(await planProperties(`select id from t where a = 5 and b > 10 and b > 30`))
						.to.match(/plan=7;prefixLen=1/);
				});

				it('a multi-value IN prefix does not emit a prefixRangeSeek', async () => {
					expect(await planProperties(`select id from t where a in (5, 6) and b >= 30`))
						.to.not.match(/plan=7/);
				});

				it('two-sided inclusive window', async () =>
					expect(await ids(`select id from t where a = 5 and b >= 20 and b <= 30 order by id`))
						.to.deep.equal([2, 3]));

				it('two-sided exclusive window', async () =>
					expect(await ids(`select id from t where a = 5 and b > 10 and b < 40 order by id`))
						.to.deep.equal([2, 3]));

				it('between behaves as the inclusive two-sided window', async () =>
					expect(await ids(`select id from t where a = 5 and b between 20 and 30 order by id`))
						.to.deep.equal([2, 3]));

				it('lower bound only', async () =>
					expect(await ids(`select id from t where a = 5 and b > 20 order by id`))
						.to.deep.equal([3, 4]));

				it('upper bound only', async () =>
					expect(await ids(`select id from t where a = 5 and b <= 20 order by id`))
						.to.deep.equal([1, 2]));

				it('the prefix still confines the window (rows of the other group never leak)', async () =>
					expect(await ids(`select id from t where a = 6 and b >= 20 order by id`))
						.to.deep.equal([5, 6]));

				it('an empty window yields no rows', async () =>
					expect(await ids(`select id from t where a = 5 and b > 40 and b < 100`)).to.deep.equal([]));

				it('a bound below every stored value still confines to the prefix group', async () =>
					expect(await ids(`select id from t where a = 5 and b >= 0 order by id`))
						.to.deep.equal([1, 2, 3, 4]));

				// Only the FIRST bound per role may be claimed handled; a later duplicate must
				// survive in the residual Filter (see claimFirstPerRole).
				it('two lower bounds: the tighter one is not dropped', async () =>
					expect(await ids(`select id from t where a = 5 and b > 10 and b > 30 order by id`))
						.to.deep.equal([4]));

				it('two upper bounds: the tighter one is not dropped', async () =>
					expect(await ids(`select id from t where a = 5 and b < 40 and b < 20 order by id`))
						.to.deep.equal([1]));

				it('mixed same-side ops (> and >=) keep both', async () =>
					expect(await ids(`select id from t where a = 5 and b > 10 and b >= 30 order by id`))
						.to.deep.equal([3, 4]));

				// The rule can only seek a SINGLE-valued prefix key, so this arm must decline
				// and let the IN take the multi-seek path with `b` residual.
				it('a multi-value IN prefix does not take the arm, and stays correct', async () =>
					expect(await ids(`select id from t where a in (5, 6) and b >= 30 order by id`))
						.to.deep.equal([3, 4, 6]));
			});

			it('DESC trailing column seeks under byte inversion', async () => {
				await db.exec(`create table d (id integer primary key, a integer, b integer) using store`);
				await db.exec(`create index ix_d on d (a asc, b desc)`);
				await db.exec(`insert into d values (1, 5, 10), (2, 5, 20), (3, 5, 30), (4, 5, 40), (5, 6, 20)`);
				expect(await planOps(`select id from d where a = 5 and b >= 20 and b <= 30`))
					.to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
				expect(await ids(`select id from d where a = 5 and b >= 20 and b <= 30 order by id`))
					.to.deep.equal([2, 3]);
				expect(await ids(`select id from d where a = 5 and b > 30 order by id`)).to.deep.equal([4]);
				expect(await ids(`select id from d where a = 5 and b < 20 order by id`)).to.deep.equal([1]);
			});

			it('a DESC PREFIX column does not swap the trailing assignment', async () => {
				// A DESC prefix column inverts bytes INSIDE a prefix that stays fixed, so only
				// the bounded column's direction may drive the lower/upper swap.
				await db.exec(`create table dp (id integer primary key, a integer, b integer) using store`);
				await db.exec(`create index ix_dp on dp (a desc, b asc)`);
				await db.exec(`insert into dp values (1, 5, 10), (2, 5, 20), (3, 5, 30), (4, 6, 20)`);
				expect(await ids(`select id from dp where a = 5 and b >= 20 order by id`)).to.deep.equal([2, 3]);
				expect(await ids(`select id from dp where a = 5 and b < 20 order by id`)).to.deep.equal([1]);
			});

			it('a three-column index bounds the THIRD column under a two-column prefix', async () => {
				await db.exec(`create table t3 (id integer primary key, a integer, b integer, c integer) using store`);
				await db.exec(`create index ix_abc on t3 (a, b, c)`);
				await db.exec(`insert into t3 values (1,1,1,10), (2,1,1,20), (3,1,1,30), (4,1,2,20), (5,2,1,20)`);
				expect(await ids(`select id from t3 where a = 1 and b = 1 and c >= 20 order by id`))
					.to.deep.equal([2, 3]);
				expect(await planProperties(`select id from t3 where a = 1 and b = 1 and c >= 20`))
					.to.match(/plan=7;prefixLen=2/);
			});

			// A bound on a column PAST the one right after the prefix is not seekable: the
			// window would have to skip over `b`, which the single-column bound cannot express.
			// The prefix seek serves and `c` stays residual.
			it('a bound on a LATER column than the prefix successor stays residual', async () => {
				await db.exec(`create table t4 (id integer primary key, a integer, b integer, c integer) using store`);
				await db.exec(`create index ix_a_bc on t4 (a, b, c)`);
				await db.exec(`insert into t4 values (1,1,1,10), (2,1,1,30), (3,1,2,10), (4,2,1,30)`);
				expect(await ids(`select id from t4 where a = 1 and c >= 30 order by id`)).to.deep.equal([2]);
				expect(await planProperties(`select id from t4 where a = 1 and c >= 30`))
					.to.not.match(/plan=7/);
			});

			// A trailing bound whose VALUE has no faithful byte position under the column's
			// semantic type (a numeric probe against TIMESPAN) is dropped from the window.
			// The prefix window — a strict superset — still serves and `matchesFilters`
			// re-applies the bound under the type's own compare, so the rows must not move.
			it('an unfaithful semantic trailing bound widens to the prefix window, rows unchanged', async () => {
				const seed = async (name: string, using: string) => {
					await db.exec(`create table ${name} (id integer primary key, a integer, d timespan) ${using}`);
					await db.exec(`create index ix_${name} on ${name} (a, d)`);
					await db.exec(`insert into ${name} values
						(1, 1, 'PT5S'), (2, 1, 'PT30M'), (3, 1, 'PT2H'), (4, 2, 'PT1M')`);
				};
				await seed('tsstore', 'using store');
				await seed('tsmem', '');
				for (const where of [`a = 1 and d > 'PT10M'`, `a = 1 and d > 5`, `a = 1 and d <= 'PT2H'`]) {
					const q = (t: string) => `select id from ${t} where ${where} order by id`;
					expect(await asyncIterableToArray(db.eval(q('tsstore'))), where)
						.to.deep.equal(await asyncIterableToArray(db.eval(q('tsmem'))));
				}
			});

			it('results match the memory-module oracle', async () => {
				const seed = async (name: string, using: string) => {
					await db.exec(`create table ${name} (id integer primary key, a integer, b integer) ${using}`);
					await db.exec(`create index ix_${name} on ${name} (a, b)`);
					await db.exec(`insert into ${name} values
						(1, 5, 10), (2, 5, 20), (3, 5, 30), (4, 6, 20), (5, 7, 5)`);
				};
				await seed('pstore', 'using store');
				await seed('pmem', '');
				for (const where of [
					`a = 5 and b >= 20`,
					`a = 5 and b between 10 and 20`,
					`a = 5 and b < 30`,
					`a = 5 and b > 10 and b > 25`,
					`a in (5, 6) and b >= 20`,
					`a = 7 and b >= 0`,
				]) {
					const q = (t: string) => `select id from ${t} where ${where} order by id`;
					expect(await asyncIterableToArray(db.eval(q('pstore'))), where)
						.to.deep.equal(await asyncIterableToArray(db.eval(q('pmem'))));
				}
			});

			it('reads-own-writes: pending rows inside the narrowed window surface, outside ones do not', async () => {
				await db.exec(`create table rw2 (id integer primary key, a integer, b integer) using store`);
				await db.exec(`create index ix_rw2 on rw2 (a, b)`);
				await db.exec(`insert into rw2 values (1, 5, 10), (2, 5, 20), (3, 5, 90), (4, 6, 25)`);
				await db.exec('begin');
				await db.exec(`insert into rw2 values (5, 5, 25), (6, 5, 95), (7, 6, 26)`);
				await db.exec(`delete from rw2 where id = 2`);
				const inWindow = await ids(`select id from rw2 where a = 5 and b >= 20 and b <= 30 order by id`);
				const outOfWindow = await ids(`select id from rw2 where a = 5 and b >= 90 order by id`);
				await db.exec('rollback');
				expect(inWindow, 'pending insert inside the window is visible; pending delete is applied')
					.to.deep.equal([5]);
				expect(outOfWindow).to.deep.equal([3, 6]);
			});

			// A trailing column whose key bytes do not reproduce its comparator's ORDER cannot
			// be windowed. The plan degrades to the plain prefix seek and leaves the bound
			// unclaimed, so the residual Filter decides the rows.
			it('a non-order-preserving trailing collation degrades to the prefix seek, residual intact', async () => {
				// Lowercase-equal but SHORTER-first: 'aa' > 'b' by comparator, 'aa' < 'b' in bytes.
				db.registerCollation('NOCASE', (x: string, y: string) => {
					if (x.length !== y.length) return x.length - y.length;
					const [lx, ly] = [x.toLowerCase(), y.toLowerCase()];
					return lx < ly ? -1 : lx > ly ? 1 : 0;
				}, { normalizer: (s: string) => s.toLowerCase() });

				await db.exec(`create table nc (id integer primary key, a integer, s text collate nocase) using store`);
				await db.exec(`create index ix_nc on nc (a, s)`);
				await db.exec(`insert into nc values (1, 1, 'aa'), (2, 1, 'b'), (3, 2, 'aa')`);

				// A byte window at `> 'b'` would start past 'aa' and lose row 1.
				expect(await ids(`select id from nc where a = 1 and s > 'b' order by id`)).to.deep.equal([1]);
				// The equality prefix still seeks — only the trailing bound was given up.
				expect(await planOps(`select id from nc where a = 1 and s > 'b'`))
					.to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
			});
		});

		// IN-list multi-seek (feat-store-in-list-index-pushdown): an IN on an indexed
		// column is served as one deduplicated, key-ordered point seek per distinct
		// list value (`plan=5`) instead of a full scan + residual. The runtime is the
		// authority for NULL-skip and dedup — parameter-bound lists reach it unreduced.
		describe('IN-list multi-seek (feat-store-in-list-index-pushdown)', () => {
			const ids = async (q: string, params?: SqlValue[]) =>
				(await asyncIterableToArray(db.eval(q, params))).map(r => r.id as number);

			describe('single-column index', () => {
				beforeEach(async () => {
					await db.exec(`create table t (id integer primary key, v integer) using store`);
					await db.exec(`create index ix_v on t (v)`);
					await db.exec(`insert into t values (1, 10), (2, 20), (3, 30), (4, 40), (5, 20)`);
				});

				it('IN on the indexed column picks the index seek, not a scan', async () => {
					const ops = await planOps(`select id from t where v in (10, 30)`);
					expect(ops).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
					expect(ops).to.not.match(/SEQSCAN|SEQ SCAN|SeqScan/i);
				});

				it('basic IN list returns exactly the matching rows', async () =>
					expect(await ids(`select id from t where v in (10, 30) order by id`)).to.deep.equal([1, 3]));

				it('an IN value matching several rows returns them all', async () =>
					expect(await ids(`select id from t where v in (20, 40) order by id`)).to.deep.equal([2, 4, 5]));

				it('duplicate literal values yield each row once', async () =>
					expect(await ids(`select id from t where v in (30, 30, 10) order by id`)).to.deep.equal([1, 3]));

				it('NULL in the list is ignored', async () =>
					expect(await ids(`select id from t where v in (10, null, 30) order by id`)).to.deep.equal([1, 3]));

				it('no matching values yields no rows', async () =>
					expect(await ids(`select id from t where v in (99, 123)`)).to.deep.equal([]));

				it('single-element IN still works (routed through the plain eq seek)', async () =>
					expect(await ids(`select id from t where v in (20) order by id`)).to.deep.equal([2, 5]));

				it('parameter-bound list seeks and returns correct rows (runtime dedup)', async () =>
					expect(await ids(`select id from t where v in (?, ?, ?) order by id`, [30, 10, 30])).to.deep.equal([1, 3]));

				it('parameter list with a NULL among values ignores the NULL', async () =>
					expect(await ids(`select id from t where v in (?, ?) order by id`, [null, 20])).to.deep.equal([2, 5]));

				it('all-NULL parameter list yields no rows', async () =>
					expect(await ids(`select id from t where v in (?, ?)`, [null, null])).to.deep.equal([]));

				it('single-element parameter IN still works', async () =>
					expect(await ids(`select id from t where v in (?)`, [40])).to.deep.equal([4]));

				it('IN plus limit 1 returns a single row', async () =>
					expect(await ids(`select id from t where v in (10, 30) limit 1`)).to.have.lengthOf(1));

				it('unsorted list with ORDER BY returns sorted rows (no ordering claimed)', async () => {
					const vals = (await asyncIterableToArray(db.eval(`select v from t where v in (30, 10, 20) order by v`))).map(r => r.v);
					expect(vals).to.deep.equal([10, 20, 20, 30]);
				});
			});

			it('NOCASE column: case-variant list entries match case-insensitively, each row once', async () => {
				await db.exec(`create table s (id integer primary key, name text collate nocase) using store`);
				await db.exec(`create index ix_name on s (name)`);
				await db.exec(`insert into s values (1, 'Alice'), (2, 'bob'), (3, 'ALICE'), (4, 'carol')`);
				const q = `select id from s where name in ('alice', 'Alice', 'BOB') order by id`;
				expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
				expect((await asyncIterableToArray(db.eval(q))).map(r => r.id)).to.deep.equal([1, 2, 3]);
			});

			it('BINARY column of a NOCASE-keyed table: case-variant IN values each find their row', async () => {
				// An undecorated `text` column keys BINARY whatever the table key collation is
				// (store-index-key-column-collation), so 'a' and 'A' get two DISTINCT windows
				// and the multi-seek must visit both. Note this no longer exercises the
				// merged-window case it was written for: with key collation and residual
				// collation always equal for a text column, two IN values can only share a
				// window when they are also residual-equal, so a per-tuple residual can no
				// longer drop a row.
				await db.exec(`create table b (id integer primary key, v text) using store`);
				await db.exec(`create index ix_v on b (v)`);
				await db.exec(`insert into b values (1, 'a'), (2, 'A'), (3, 'b')`);
				const q = `select id from b where v in ('a', 'A') order by id`;
				expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
				expect(await ids(q)).to.deep.equal([1, 2]);
			});

			it('DESC index column: IN list seeks under byte inversion and returns correct rows', async () => {
				await db.exec(`create table dt (id integer primary key, v integer) using store`);
				await db.exec(`create index ix_dv on dt (v desc)`);
				await db.exec(`insert into dt values (1, 10), (2, 20), (3, 30), (4, 40)`);
				const q = `select id from dt where v in (10, 40) order by id`;
				expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
				expect(await ids(q)).to.deep.equal([1, 4]);
			});

			describe('composite index (a, b)', () => {
				beforeEach(async () => {
					await db.exec(`create table ct (id integer primary key, a integer, b integer) using store`);
					await db.exec(`create index ix_ab on ct (a, b)`);
					await db.exec(`insert into ct values (1, 1, 10), (2, 1, 20), (3, 2, 10), (4, 2, 20), (5, 3, 10)`);
				});

				it('IN × IN cross-product seeks and returns exactly the matching rows', async () => {
					const q = `select id from ct where a in (1, 2) and b in (10, 20) order by id`;
					expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
					expect(await ids(q)).to.deep.equal([1, 2, 3, 4]);
				});

				it('IN × EQ returns the matching rows', async () =>
					expect(await ids(`select id from ct where a in (1, 3) and b = 10 order by id`)).to.deep.equal([1, 5]));

				it('EQ × IN returns the matching rows', async () =>
					expect(await ids(`select id from ct where a = 2 and b in (10, 20) order by id`)).to.deep.equal([3, 4]));

				it('parameter-bound cross-product with a NULL component drops only that tuple', async () =>
					expect(await ids(`select id from ct where a in (?, ?) and b in (?, ?) order by id`, [1, null, 10, 20])).to.deep.equal([1, 2]));
			});

			it('an IN list over the multi-seek cap declines to scan + residual and stays correct', async () => {
				await db.exec(`create table big (id integer primary key, v integer) using store`);
				await db.exec(`create index ix_bv on big (v)`);
				await db.exec(`insert into big values (1, 5), (2, 500), (3, 2000)`);
				const list = Array.from({ length: 1001 }, (_, i) => i).join(', ');
				const q = `select id from big where v in (${list}) order by id`;
				expect(await planOps(q)).to.not.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
				expect(await ids(q)).to.deep.equal([1, 2]);
			});

			it('IN on an indexed TIMESPAN column declines the seek but stays correct', async () => {
				// A multi-seek drops the residual, and the byte windows would address raw
				// value bytes while the index holds the semantic key transform's — so the
				// plan must decline. The scan-path residual compares by elapsed time:
				// 'PT60M' matches the listed 'PT1H'.
				await db.exec(`create table ts (id integer primary key, d timespan) using store`);
				await db.exec(`create index ix_d on ts (d)`);
				await db.exec(`insert into ts values (1, 'PT60M'), (2, 'PT2H')`);
				const q = `select id from ts where d in ('PT1H', 'PT3H') order by id`;
				expect(await planOps(q)).to.not.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
				expect(await ids(q)).to.deep.equal([1]);
			});

			it('IN-list results match the memory-module oracle', async () => {
				const seed = async (name: string, using: string) => {
					await db.exec(`create table ${name} (id integer primary key, v integer, s text collate nocase) ${using}`);
					await db.exec(`create index ix_${name}_v on ${name} (v)`);
					await db.exec(`insert into ${name} values (1, 10, 'ant'), (2, 20, 'Bee'), (3, 30, 'cat'), (4, 20, 'BEE')`);
				};
				await seed('ostore', 'using store');
				await seed('omem', '');
				for (const where of [
					`v in (10, 30)`,
					`v in (20)`,
					`v in (20, 99, 20)`,
					`s in ('bee', 'CAT')`,
				]) {
					const q = (t: string) => `select id from ${t} where ${where} order by id`;
					const storeRows = await asyncIterableToArray(db.eval(q('ostore')));
					const memRows = await asyncIterableToArray(db.eval(q('omem')));
					expect(storeRows, where).to.deep.equal(memRows);
				}
			});

			it('reads-own-writes: an uncommitted row whose indexed value is in the list surfaces', async () => {
				await db.exec(`create table rw (id integer primary key, v integer) using store`);
				await db.exec(`create index ix_rw on rw (v)`);
				await db.exec(`insert into rw values (1, 10), (2, 20)`);
				await db.exec('begin');
				await db.exec(`insert into rw values (3, 30)`);
				const rows = await ids(`select id from rw where v in (20, 30) order by id`);
				await db.exec('commit');
				expect(rows).to.deep.equal([2, 3]);
			});

			it('index whose leading column IS the primary key: the multi-seek is not hijacked by the PK point arm', async () => {
				// StoreTable.query must test for `plan=5` BEFORE analyzePKAccess. The
				// FilterInfo carries N EQ constraints on the same column; analyzePKAccess
				// takes the FIRST of them as a full PK match and point-reads one value,
				// whose matchesFilters then ANDs all N mutually-exclusive equalities —
				// zero rows, silently. Only an index over the PK column reaches that arm.
				await db.exec(`create table pk (k integer primary key, other text) using store`);
				await db.exec(`create index ix_k on pk (k)`);
				await db.exec(`insert into pk values (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd')`);
				const q = `select k from pk where k in (1, 3) order by k`;
				expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
				expect((await asyncIterableToArray(db.eval(q))).map(r => r.k)).to.deep.equal([1, 3]);
			});

			it('composite index with mixed ASC/DESC columns cross-products correctly', async () => {
				// Each seek window is encoded with its own column's DESC inversion, and the
				// windows are then sorted by raw bytes — so a per-column direction mix is
				// the case where a single shared direction would silently misorder them.
				await db.exec(`create table md (id integer primary key, a integer, b text) using store`);
				await db.exec(`create index ix_md on md (a asc, b desc)`);
				await db.exec(`insert into md values (1,1,'x'), (2,1,'y'), (3,2,'x'), (4,2,'y'), (5,3,'z')`);
				const q = `select id from md where a in (1, 2) and b in ('x', 'y') order by id`;
				expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
				expect(await ids(q)).to.deep.equal([1, 2, 3, 4]);
			});

			it('a list of exactly the cap still seeks (the cap is exclusive)', async () => {
				await db.exec(`create table cap (id integer primary key, v integer) using store`);
				await db.exec(`create index ix_cap on cap (v)`);
				await db.exec(`insert into cap values (1, 5), (2, 999), (3, 5000)`);
				const list = Array.from({ length: 1000 }, (_, i) => i).join(', ');
				const q = `select id from cap where v in (${list}) order by id`;
				expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
				expect(await ids(q)).to.deep.equal([1, 2]);
			});

			// bug-store-index-choice-ignores-cost: computeBestAccessPlan used to return the
			// FIRST secondary index whose plan claimed a seek, rather than the cheapest one.
			// A cheap single-key EQ seek on `a` and an expensive 300-key IN multi-seek on `b`
			// both claim a seek here; only the declared cost tells them apart (a plain EQ
			// estimates 100 matched rows at cost ~30, a 300-value IN estimates ~450 — see the
			// ticket for the arithmetic). These three cases isolate declaration order from
			// predicate order so only the cost comparison can be making the choice.
			describe('cost-based index choice (declaration order must not decide)', () => {
				const manyValues = Array.from({ length: 300 }, (_, i) => i).join(', ');

				/** `two(id, a, b)` with identical rows, indexes created in the given order. */
				const seedTwo = async (...declarationOrder: Array<'a' | 'b'>) => {
					await db.exec(`create table two (id integer primary key, a integer, b integer) using store`);
					for (const col of declarationOrder) await db.exec(`create index ix_${col} on two (${col})`);
					await db.exec(`insert into two values (1, 7, 5), (2, 7, 999), (3, 3, 5)`);
				};

				it('cheaper index declared second still wins', async () => {
					await seedTwo('b', 'a');
					const q = `select id from two where a = 7 and b in (${manyValues}) order by id`;
					expect(await planDetails(q)).to.match(/USING ix_a\b/);
					expect(await ids(q)).to.deep.equal([1]);
				});

				it('same declaration order, same predicate: cheaper index still wins', async () => {
					await seedTwo('a', 'b');
					const q = `select id from two where a = 7 and b in (${manyValues}) order by id`;
					expect(await planDetails(q)).to.match(/USING ix_a\b/);
					expect(await ids(q)).to.deep.equal([1]);
				});

				it('reversed predicate, fixed declaration order: the cheaper index still wins (proves cost, not order)', async () => {
					await seedTwo('a', 'b');
					const q = `select id from two where a in (${manyValues}) and b = 5 order by id`;
					expect(await planDetails(q)).to.match(/USING ix_b\b/);
					expect(await ids(q)).to.deep.equal([1, 3]);
				});

				// Two plain EQ seeks on single-column indexes price identically, so the strict
				// '<' comparison never displaces the incumbent: the FIRST-declared index wins.
				// Not an arbitrary outcome to be preserved for its own sake — it pins that the
				// choice stays stable across runs rather than flipping on an equal-cost tie.
				for (const [first, second] of [['a', 'b'], ['b', 'a']] as const) {
					it(`equal-cost tie is broken deterministically by declaration order (${first} then ${second})`, async () => {
						await seedTwo(first, second);
						const q = `select id from two where a = 7 and b = 5 order by id`;
						expect(await planDetails(q)).to.match(new RegExp(`USING ix_${first}\\b`));
						expect(await ids(q)).to.deep.equal([1]);
					});
				}

				it('three competing indexes: the cheapest wins even declared in the middle', async () => {
					await db.exec(`create table three (id integer primary key, a integer, b integer, c integer) using store`);
					await db.exec(`create index ix_a on three (a)`);
					await db.exec(`create index ix_b on three (b)`);
					await db.exec(`create index ix_c on three (c)`);
					await db.exec(`insert into three values (1, 7, 5, 9), (2, 7, 999, 9), (3, 3, 5, 9)`);
					// Cheap EQ on `b`, expensive 300-key multi-seeks on `a` and `c` — so neither
					// "first candidate" nor "last candidate" can be mistaken for the winner.
					const q = `select id from three where a in (${manyValues}) and b = 5 and c in (${manyValues}) order by id`;
					expect(await planDetails(q)).to.match(/USING ix_b\b/);
					expect(await ids(q)).to.deep.equal([1, 3]);
				});
			});
		});

		// Narrowing proof: rows alone cannot distinguish a multi-seek from a full scan
		// + residual, so count the DATA store's operations. Index entries live in the
		// (plain) index store; the seek resolves each matched entry with one data-store
		// `get`, while a full scan would ITERATE all 100 data rows.
		describe('IN-list multi-seek narrowing (counting data store)', () => {
			let cdb: Database;
			let cprovider: KVStoreProvider;
			let dataStores: Map<string, CountingKVStore>;

			beforeEach(() => {
				dataStores = new Map();
				cprovider = createCountingProvider(dataStores);
				cdb = new Database();
				cdb.registerModule('store', new StoreModule(cprovider));
			});

			afterEach(async () => {
				await cprovider.closeAll();
			});

			it('IN-list on an indexed column reads only the matching data rows, not the table', async () => {
				await cdb.exec(`create table nums (id integer primary key, v integer) using store`);
				await cdb.exec(`create index ix_v on nums (v)`);
				const vals = Array.from({ length: 100 }, (_, i) => `(${i}, ${i})`).join(', ');
				await cdb.exec(`insert into nums values ${vals}`);
				const store = dataStores.get('main.nums')!;
				store.iterateEntryCount = 0;
				store.getCount = 0;

				const rows = await asyncIterableToArray(cdb.eval(`select id from nums where v in (5, 7, 9) order by id`));
				expect(rows.map(r => r.id)).to.deep.equal([5, 7, 9]);
				// No data-store scan at all (a full scan would iterate all 100 rows) …
				expect(store.iterateEntryCount, 'no data-store iteration').to.equal(0);
				// … and only the 3 matched index entries resolve to data-store reads.
				expect(store.getCount, 'one read per matched entry').to.be.within(1, 6);
				// The three single-entry windows resolve in ONE getMany round trip, not one
				// awaited read per window (store-index-seek-batched-scan).
				expect(store.getManyCalls, 'row resolution collapses into one batch').to.equal(1);
				expect(store.getManyKeyCount, 'exactly the matched entries are batched').to.equal(3);
			});

			// The point of the prefix-range arm: the equality prefix here is NOT selective
			// (every row shares `a = 1`), so a prefix-only window resolves all 100 entries to
			// 100 data-store reads. The narrowed window resolves only the in-range slice.
			it('prefix-range seek reads only the in-range rows, not the whole prefix group', async () => {
				await cdb.exec(`create table ab (id integer primary key, a integer, b integer) using store`);
				await cdb.exec(`create index ix_ab on ab (a, b)`);
				const vals = Array.from({ length: 100 }, (_, i) => `(${i}, 1, ${i})`).join(', ');
				await cdb.exec(`insert into ab values ${vals}`);
				const store = dataStores.get('main.ab')!;
				store.iterateEntryCount = 0;
				store.getCount = 0;

				const rows = await asyncIterableToArray(
					cdb.eval(`select id from ab where a = 1 and b >= 96 order by id`),
				);
				expect(rows.map(r => r.id)).to.deep.equal([96, 97, 98, 99]);
				expect(store.iterateEntryCount, 'no data-store iteration').to.equal(0);
				expect(store.getCount, 'only the in-window entries resolve to data reads').to.be.at.most(8);
				// The 4 in-window entries resolve in one batch round trip.
				expect(store.getManyCalls, 'row resolution collapses into one batch').to.equal(1);
			});
		});

		// A secondary-index path reads the index ENTRY and then the ROW it names, while a
		// sequential scan reads one row per row. These pin that the second read is priced
		// (ROW_RESOLUTION_COST, 1.0 per fetched row) and that the module now returns the
		// sequential scan when a seek prices above it.
		describe('row-resolution cost and the seek-versus-scan comparison', () => {
			/** The module's own plan for `filters` against `table`, at a stated table size. */
			function planFor(
				tableName: string,
				filters: PredicateConstraint[],
				estimatedRows: number,
			): BestAccessPlanResult {
				const table = db.schemaManager.getTable('main', tableName);
				expect(table, `table ${tableName} should exist`).to.exist;
				return storeModule.getBestAccessPlan(db, table!, {
					columns: table!.columns.map((col, index) => ({
						index,
						name: col.name,
						type: col.logicalType,
						isPrimaryKey: col.primaryKey || false,
						isUnique: col.primaryKey || false,
					})),
					filters,
					estimatedRows,
				});
			}

			const eq = (columnIndex: number, value: SqlValue): PredicateConstraint =>
				({ columnIndex, op: '=', value, usable: true });
			const gte = (columnIndex: number, value: SqlValue): PredicateConstraint =>
				({ columnIndex, op: '>=', value, usable: true });

			beforeEach(async () => {
				// One index per table: an `a = ?` predicate suits BOTH `ix_a` and the leading
				// prefix of a composite `(a, b)`, and the two price identically, so a shared
				// table would leave the winner to declaration order rather than to the arm.
				await db.exec(`create table costed (id integer primary key, a integer, b integer) using store`);
				await db.exec(`create index ix_a on costed (a)`);
				await db.exec(`create table costed_r (id integer primary key, a integer, b integer) using store`);
				await db.exec(`create index ix_b on costed_r (b)`);
				await db.exec(`create table costed_p (id integer primary key, a integer, b integer) using store`);
				await db.exec(`create index ix_ab on costed_p (a, b)`);
			});

			// Each arm: `AccessPlanBuilder`'s own shape (0.3 per row for an equality seek,
			// 0.5 for a range) PLUS 1.0 per row for resolving each entry to its row.
			for (const { arm, table, filters, selectivity, indexCost, perRow, indexName } of [
				{
					arm: 'eq', table: 'costed', filters: [eq(1, 7)],
					selectivity: 0.1, indexCost: 0.3, perRow: 0.3, indexName: 'ix_a',
				},
				{
					arm: 'range', table: 'costed_r', filters: [gte(2, 7)],
					selectivity: 0.3, indexCost: 0.2, perRow: 0.5, indexName: 'ix_b',
				},
				{
					arm: 'prefixRange', table: 'costed_p', filters: [eq(1, 7), gte(2, 7)],
					selectivity: 0.15, indexCost: 0.2, perRow: 0.5, indexName: 'ix_ab',
				},
			] as const) {
				it(`the ${arm} arm charges 1.0 per fetched row on top of its index-entry cost`, () => {
					const plan = planFor(table, [...filters], 1000);
					expect(plan.indexName, 'the arm under test was chosen').to.equal(indexName);
					const rows = Math.floor(1000 * selectivity);
					expect(plan.rows).to.equal(rows);
					expect(plan.cost).to.be.closeTo(indexCost + rows * (perRow + 1.0), 1e-9);
				});
			}

			it('a cost-only decline pays no resolution term (it resolves nothing)', () => {
				// A real cost-only plan, not a plain scan: an IN above the 1000-seek cap declines
				// to cost-only on `ix_a`, so it keeps the arm's SHAPE (eq, 0.3 + 0.3 per row over
				// 10% of the table) while performing a sequential scan that resolves no index
				// entry. 30.3, not the 130.3 a seeking eq arm on the same 100 rows would price.
				const plan = planFor('costed', [{
					columnIndex: 1, op: 'IN', usable: true, runtimeSet: { maxCount: 1001 },
				}], 1000);
				expect(plan.explains, 'declined by the seek cap').to.match(/cost-only; IN cross-product/);
				expect(plan.indexName, 'so it advertises no seek').to.be.undefined;
				expect(plan.handledFilters).to.deep.equal([false]);
				expect(plan.rows).to.equal(100);
				expect(plan.cost).to.be.closeTo(0.3 + 100 * 0.3, 1e-9);
			});

			it('a partial index is never seeked, so nothing pays the resolution term', async () => {
				await db.exec(`create table parti (id integer primary key, v integer) using store`);
				await db.exec(`create index ix_pos on parti (v) where v > 0`);
				const plan = planFor('parti', [eq(1, 7)], 1000);
				expect(plan.handledFilters).to.deep.equal([false]);
				expect(plan.cost, 'the plain sequential 1.0 per row').to.equal(1000);
			});

			it('a selective indexed predicate still beats the sequential scan', async () => {
				await db.exec(`insert into costed values ${
					Array.from({ length: 50 }, (_, i) => `(${i + 1}, ${i + 1}, ${i + 1})`).join(', ')}`);
				const q = `select id from costed where a = 7 order by id`;
				expect(await planDetails(q)).to.match(/USING ix_a\b/);
				expect((await asyncIterableToArray(db.eval(q))).map(r => r.id)).to.deep.equal([7]);
			});

			it('a seek the model prices above a sequential scan loses it, and returns the same rows', async () => {
				// The reachable case today: the arm estimates the WHOLE table. `ARM_SELECTIVITY`
				// is a fixed fraction with a `max(1, …)` floor, so that means a one-row table —
				// where an index seek really does cost more (index entry + row) than reading the
				// single row. A predicate matching most of a LARGE table is still priced at the
				// arm's 10%, and no per-row term can flip it; see the NOTE on ARM_SELECTIVITY.
				await db.exec(`create table lone (id integer primary key, v integer) using store`);
				await db.exec(`create index ix_lv on lone (v)`);
				await db.exec(`insert into lone values (1, 7)`);

				// eq arm at N=1: 0.3 + 1 × (0.3 + 1.0) = 1.6, against a 1.0 sequential scan.
				const plan = planFor('lone', [eq(1, 7)], 1);
				expect(plan.indexName, 'the seek lost').to.be.undefined;
				expect(plan.handledFilters, 'so the predicate goes back to the residual').to.deep.equal([false]);
				expect(plan.cost).to.equal(1);
				expect(plan.explains).to.match(/cheaper than the best index seek/);

				// Through SQL the size has to come from ANALYZE: an un-analyzed table reaches
				// the module carrying the catalog's 1000-row placeholder (the planner's hint
				// WINS over the live count the store keeps — see `StoreModule`), so without
				// this the arm is priced for a 1000-row table and the seek is the right plan.
				await db.exec(`analyze lone`);
				const q = `select id from lone where v = 7`;
				expect(await planDetails(q), 'the plan walks the table').to.not.match(/USING ix_lv\b/);
				expect((await asyncIterableToArray(db.eval(q))).map(r => r.id),
					'the residual keeps the answer identical').to.deep.equal([1]);
				expect((await asyncIterableToArray(db.eval(`select id from lone where v = 99`))).map(r => r.id))
					.to.deep.equal([]);
			});

			it('the multi-seek arm is exempt: it keeps naming its index however it prices', () => {
				// `rule-key-set-seek` probes this module at 2 and 1000 keys to read the arm's
				// cost SLOPE, and abandons the rewrite if a probe stops naming an index — so the
				// comparison must not answer a synthesized 1000-key probe with a scan.
				const in1000: PredicateConstraint = {
					columnIndex: 1, op: 'IN', usable: true, runtimeSet: { maxCount: 1000 },
				};
				const plan = planFor('costed', [in1000], 200);
				expect(plan.cost, 'priced above a 200-row scan').to.be.greaterThan(200);
				expect(plan.indexName, 'and still advertised as a seek').to.equal('ix_a');
				expect(plan.seekColumnIndexes).to.deep.equal([1]);
			});
		});
	});
});
