import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, MemoryTableModule, asyncIterableToArray, makeFullScanFilterInfo } from '@quereus/quereus';
import type { BestAccessPlanRequest, BestAccessPlanResult, Database as Db, SqlValue, TableSchema } from '@quereus/quereus';
import { IsolationModule } from '../src/index.js';

/**
 * Pins the isolation layer's primary-key probe invariant:
 *
 * **A hand-built FilterInfo is a seek REQUEST, not a contract — the answer may be a
 * superset, so every probe verifies the key of each row it gets back.**
 *
 * The layer's three PK probes (`getUnderlyingRow`, `getOverlayRow`, and the commit
 * flush's `rowExistsInUnderlying`) call `VirtualTable.query()` directly with a
 * FilterInfo they built themselves. The module never claimed those constraints through
 * `getBestAccessPlan`, and no engine sits above a direct `query()` call to reapply them
 * as a residual — so a module that cannot seek the requested columns may legally answer
 * with the whole table.
 *
 * The regression this guards: the probes returned row #1 of whatever came back. Against
 * a scan-only underlying that made a distinct primary key look occupied
 * (`UNIQUE constraint failed: t PK.` for a key not in the table), and — once the
 * conflict check was fixed in isolation — made the flush classify a fresh key as an
 * update, writing against a key that does not exist and silently losing the row.
 *
 * The trigger is the MODULE, not the column type: an `integer` primary key reproduces
 * it. A semantic-ordering type (TIMESPAN, JSON) only makes declining the seek the
 * *correct* thing for a module to do, which is how the original report hit it.
 */

type UnderlyingTable = Awaited<ReturnType<MemoryTableModule['create']>>;

/**
 * A module that declines every pushed filter and answers every `query()` with a full
 * scan — the legal shape for a module that cannot seek the requested column.
 *
 * Declining at plan time keeps ordinary SQL correct: the engine keeps the residual
 * predicate above the module. Only the isolation layer's hand-built probes, which
 * bypass the planner entirely, see the unfiltered answer.
 */
class ScanOnlyMemoryModule extends MemoryTableModule {
	override getBestAccessPlan(_db: Db, _tableInfo: TableSchema, request: BestAccessPlanRequest): BestAccessPlanResult {
		const rows = request.estimatedRows ?? 1000;
		return { handledFilters: request.filters.map(() => false), rows, cost: rows };
	}

	private wrap(table: UnderlyingTable): UnderlyingTable {
		return new Proxy(table, {
			get(target, prop) {
				if (prop === 'query') {
					return () => target.query!(makeFullScanFilterInfo());
				}
				const value = Reflect.get(target, prop, target);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
	}

	override async create(...args: Parameters<MemoryTableModule['create']>): Promise<UnderlyingTable> {
		return this.wrap(await super.create(...args));
	}

	override async connect(...args: Parameters<MemoryTableModule['connect']>): Promise<UnderlyingTable> {
		return this.wrap(await super.connect(...args));
	}
}

async function openScanOnlyDb(ddl: string): Promise<Database> {
	const db = new Database();
	db.registerModule('isolated', new IsolationModule({ underlying: new ScanOnlyMemoryModule() }));
	await db.exec(ddl);
	return db;
}

describe('isolation PK probe vs an underlying that scans', () => {
	let db: Database;

	beforeEach(async () => {
		db = await openScanOnlyDb('create table t (k integer primary key, v text) using isolated');
	});

	afterEach(async () => {
		await db.close();
	});

	async function rows(): Promise<SqlValue[][]> {
		const out = await asyncIterableToArray(db.eval('select k, v from t order by k'));
		return out.map((r: Record<string, SqlValue>) => [r.k, r.v]);
	}

	it('autocommit: a second insert with a distinct PK is not a conflict', async () => {
		await db.exec(`insert into t values (1, 'one')`);
		await db.exec(`insert into t values (2, 'two')`);
		expect(await rows()).to.deep.equal([[1, 'one'], [2, 'two']]);
	});

	it('explicit transaction: a fresh PK is inserted, not swallowed', async () => {
		await db.exec(`insert into t values (1, 'one')`);
		await db.exec('begin');
		await db.exec(`insert into t values (2, 'two')`);
		await db.exec('commit');
		expect(await rows()).to.deep.equal([[1, 'one'], [2, 'two']]);
	});

	it('several fresh PKs staged in one transaction all reach the underlying', async () => {
		// The flush arm on its own: every entry is an insert, and a probe that believed
		// row #1 would classify each as an update against a key that does not exist.
		await db.exec(`insert into t values (1, 'one')`);
		await db.exec('begin');
		await db.exec(`insert into t values (2, 'two')`);
		await db.exec(`insert into t values (3, 'three')`);
		await db.exec(`insert into t values (4, 'four')`);
		await db.exec('commit');
		expect(await rows()).to.deep.equal([[1, 'one'], [2, 'two'], [3, 'three'], [4, 'four']]);
	});

	it('a PK-relocating update moves the row and frees the old key', async () => {
		await db.exec(`insert into t values (1, 'one')`);
		await db.exec(`insert into t values (2, 'two')`);
		await db.exec('begin');
		await db.exec(`update t set k = 5 where k = 2`);
		await db.exec('commit');
		expect(await rows()).to.deep.equal([[1, 'one'], [5, 'two']]);

		// The freed key is genuinely reusable — the relocation left no ghost behind.
		await db.exec(`insert into t values (2, 'two-again')`);
		expect(await rows()).to.deep.equal([[1, 'one'], [2, 'two-again'], [5, 'two']]);
	});

	it('an update that does not move the PK still overwrites in place', async () => {
		await db.exec(`insert into t values (1, 'one')`);
		await db.exec(`insert into t values (2, 'two')`);
		await db.exec('begin');
		await db.exec(`update t set v = 'ONE' where k = 1`);
		await db.exec('commit');
		expect(await rows()).to.deep.equal([[1, 'ONE'], [2, 'two']]);
	});

	it('sanity: a genuine duplicate PK still conflicts', async () => {
		await db.exec(`insert into t values (1, 'one')`);
		let threw = false;
		try {
			await db.exec(`insert into t values (1, 'again')`);
		} catch {
			threw = true;
		}
		expect(threw, 'a real duplicate must still be rejected').to.be.true;
	});

	it('sanity: a genuine duplicate PK staged in a transaction still conflicts', async () => {
		// The whole-iteration scan matters here: stopping the verification at row #1
		// would report "key is free" for a key the scan carries further down.
		await db.exec(`insert into t values (1, 'one')`);
		await db.exec(`insert into t values (2, 'two')`);
		await db.exec(`insert into t values (3, 'three')`);
		await db.exec('begin');
		let threw = false;
		try {
			await db.exec(`insert into t values (3, 'again')`);
		} catch {
			threw = true;
		}
		await db.exec('rollback');
		expect(threw, 'a real duplicate must still be rejected').to.be.true;
		expect(await rows()).to.deep.equal([[1, 'one'], [2, 'two'], [3, 'three']]);
	});
});

describe('isolation PK probe vs an underlying that scans — compound PK', () => {
	let db: Database;

	beforeEach(async () => {
		db = await openScanOnlyDb(
			'create table t (a integer, b integer, v text, primary key (a, b)) using isolated');
	});

	afterEach(async () => {
		await db.close();
	});

	async function rows(): Promise<SqlValue[][]> {
		const out = await asyncIterableToArray(db.eval('select a, b, v from t order by a, b'));
		return out.map((r: Record<string, SqlValue>) => [r.a, r.b, r.v]);
	}

	it('keys sharing a leading column are distinct', async () => {
		await db.exec('begin');
		await db.exec(`insert into t values (1, 1, 'one-one')`);
		await db.exec(`insert into t values (1, 2, 'one-two')`);
		await db.exec(`insert into t values (2, 1, 'two-one')`);
		await db.exec('commit');
		expect(await rows()).to.deep.equal([
			[1, 1, 'one-one'],
			[1, 2, 'one-two'],
			[2, 1, 'two-one'],
		]);
	});

	it('sanity: a full compound-key duplicate still conflicts', async () => {
		await db.exec(`insert into t values (1, 1, 'one-one')`);
		await db.exec(`insert into t values (1, 2, 'one-two')`);
		let threw = false;
		try {
			await db.exec(`insert into t values (1, 2, 'again')`);
		} catch {
			threw = true;
		}
		expect(threw, 'a real duplicate must still be rejected').to.be.true;
	});
});

describe('isolation PK probe vs an underlying that scans — NOCASE text PK', () => {
	let db: Database;

	beforeEach(async () => {
		db = await openScanOnlyDb(
			'create table t (k text collate nocase primary key, v text) using isolated');
	});

	afterEach(async () => {
		await db.close();
	});

	async function rows(): Promise<SqlValue[][]> {
		const out = await asyncIterableToArray(db.eval('select k, v from t order by k'));
		return out.map((r: Record<string, SqlValue>) => [r.k, r.v]);
	}

	/**
	 * The one failure mode the verification could newly introduce is a FALSE MISS: a
	 * binary compare inside the probe would call 'apple' and 'APPLE' different keys, so
	 * a case-only rewrite would look like a PK relocation into a free slot and split one
	 * row into two. These tests state that the probe compares under the PK's declared
	 * collation, not by bytes.
	 */
	it('a case-only PK rewrite stays the same row', async () => {
		await db.exec(`insert into t values ('apple', 'fruit')`);
		await db.exec('begin');
		await db.exec(`update t set k = 'APPLE' where k = 'apple'`);
		await db.exec('commit');
		expect(await rows()).to.deep.equal([['APPLE', 'fruit']]);
	});

	it('a case-differing insert is a duplicate, not a fresh key', async () => {
		await db.exec(`insert into t values ('apple', 'fruit')`);
		let threw = false;
		try {
			await db.exec(`insert into t values ('APPLE', 'other')`);
		} catch {
			threw = true;
		}
		expect(threw, 'NOCASE makes this the same key').to.be.true;
		expect(await rows()).to.deep.equal([['apple', 'fruit']]);
	});

	it('genuinely distinct text keys still both land', async () => {
		await db.exec('begin');
		await db.exec(`insert into t values ('apple', 'fruit')`);
		await db.exec(`insert into t values ('banana', 'also fruit')`);
		await db.exec('commit');
		expect(await rows()).to.deep.equal([['apple', 'fruit'], ['banana', 'also fruit']]);
	});
});
