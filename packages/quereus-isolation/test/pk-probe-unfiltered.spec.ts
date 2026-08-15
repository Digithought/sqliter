import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, MemoryTableModule, asyncIterableToArray, makeFullScanFilterInfo } from '@quereus/quereus';
import type { BestAccessPlanRequest, BestAccessPlanResult, Database as Db, SqlValue, TableSchema, VirtualTableModule } from '@quereus/quereus';
import { IsolationModule } from '../src/index.js';

/**
 * Pins the isolation layer's overlay/underlying read invariant:
 *
 * **A FilterInfo a module did not negotiate is a seek REQUEST, not a contract — the answer
 * may be a superset, so the layer verifies before it believes.**
 *
 * Two families of read reach a module with constraints it never claimed:
 *
 * 1. The three primary-key probes (`getUnderlyingRow`, `getOverlayRow`, and the commit
 *    flush's `rowExistsInUnderlying`) call `VirtualTable.query()` directly with a FilterInfo
 *    they built themselves — no `getBestAccessPlan` ran at all.
 * 2. The merged primary-key read hands the OVERLAY the FilterInfo negotiated with the
 *    UNDERLYING. The engine dropped the residual on the underlying's claim; the overlay
 *    module never made one.
 *
 * Either way no engine sits above the call to reapply the constraints as a residual, so a
 * module that cannot seek the requested columns may legally answer with the whole table.
 *
 * The regressions these guard: the probes returned row #1 of whatever came back — against a
 * scan-only underlying that made a distinct primary key look occupied (`UNIQUE constraint
 * failed: t PK.` for a key not in the table), and, once the conflict check was fixed in
 * isolation, made the flush classify a fresh key as an update, writing against a key that
 * does not exist and silently losing the row. The merged read yielded the overlay's answer
 * unwindowed, surfacing staged rows from outside the query's window.
 *
 * The trigger is the MODULE, not the column type: an `integer` primary key reproduces it. A
 * semantic-ordering type (TIMESPAN, JSON) only makes declining the seek the *correct* thing
 * for a module to do, which is how the original report hit it.
 */

type AnyTable = Awaited<ReturnType<MemoryTableModule['create']>>;

/**
 * A module that declines every pushed filter and answers every `query()` with a full
 * scan — the legal shape for a module that cannot seek the requested column.
 *
 * Declining at plan time keeps ordinary SQL correct: the engine keeps the residual
 * predicate above the module. Only the isolation layer's own reads, which consume a
 * FilterInfo this module never claimed, see the unfiltered answer.
 */
class ScanOnlyMemoryModule extends MemoryTableModule {
	override getBestAccessPlan(_db: Db, _tableInfo: TableSchema, request: BestAccessPlanRequest): BestAccessPlanResult {
		const rows = request.estimatedRows ?? 1000;
		return { handledFilters: request.filters.map(() => false), rows, cost: rows };
	}

	private wrap(table: AnyTable): AnyTable {
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

	override async create(...args: Parameters<MemoryTableModule['create']>): Promise<AnyTable> {
		return this.wrap(await super.create(...args));
	}

	override async connect(...args: Parameters<MemoryTableModule['connect']>): Promise<AnyTable> {
		return this.wrap(await super.connect(...args));
	}
}

async function openDb(
	ddl: string,
	modules: { underlying: VirtualTableModule<any, any>; overlay?: VirtualTableModule<any, any> },
): Promise<Database> {
	const db = new Database();
	db.registerModule('isolated', new IsolationModule(modules));
	await db.exec(ddl);
	return db;
}

/** Scan-only UNDERLYING, default (seeking) memory overlay. */
function openScanOnlyUnderlyingDb(ddl: string): Promise<Database> {
	return openDb(ddl, { underlying: new ScanOnlyMemoryModule() });
}

/** Seeking underlying, scan-only OVERLAY — the `IsolationConfig.overlay` arm. */
function openScanOnlyOverlayDb(ddl: string): Promise<Database> {
	return openDb(ddl, { underlying: new MemoryTableModule(), overlay: new ScanOnlyMemoryModule() });
}

/**
 * Asserts `run()` rejects with a constraint violation naming the expected constraint —
 * not merely that *something* threw, which a typo in the SQL would also satisfy.
 */
async function expectConstraintFailure(run: () => Promise<unknown>, matching: RegExp): Promise<void> {
	let error: unknown;
	try {
		await run();
	} catch (e) {
		error = e;
	}
	expect(error, 'expected a constraint violation, but the statement succeeded').to.not.be.undefined;
	expect(String((error as Error).message)).to.match(matching);
}

const DUPLICATE_PK = /UNIQUE constraint failed/i;

describe('isolation PK probe vs an underlying that scans', () => {
	let db: Database;

	beforeEach(async () => {
		db = await openScanOnlyUnderlyingDb('create table t (k integer primary key, v text) using isolated');
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

	it('a staged delete removes exactly its own row', async () => {
		// A tombstone resolves through the same probes; believing row #1 could delete
		// against a key the overlay never staged.
		await db.exec(`insert into t values (1, 'one')`);
		await db.exec(`insert into t values (2, 'two')`);
		await db.exec(`insert into t values (3, 'three')`);
		await db.exec('begin');
		await db.exec('delete from t where k = 2');
		await db.exec('commit');
		expect(await rows()).to.deep.equal([[1, 'one'], [3, 'three']]);
	});

	it('a delete and a re-insert of the same key in one transaction lands the new row', async () => {
		await db.exec(`insert into t values (1, 'one')`);
		await db.exec(`insert into t values (2, 'two')`);
		await db.exec('begin');
		await db.exec('delete from t where k = 2');
		await db.exec(`insert into t values (2, 'two-again')`);
		await db.exec('commit');
		expect(await rows()).to.deep.equal([[1, 'one'], [2, 'two-again']]);
	});

	it('a rolled-back transaction leaves the committed rows untouched', async () => {
		await db.exec(`insert into t values (1, 'one')`);
		await db.exec('begin');
		await db.exec(`insert into t values (2, 'two')`);
		await db.exec(`update t set v = 'ONE' where k = 1`);
		await db.exec('rollback');
		expect(await rows()).to.deep.equal([[1, 'one']]);
	});

	it('sanity: a genuine duplicate PK still conflicts', async () => {
		await db.exec(`insert into t values (1, 'one')`);
		await expectConstraintFailure(() => db.exec(`insert into t values (1, 'again')`), DUPLICATE_PK);
	});

	it('sanity: a genuine duplicate PK staged in a transaction still conflicts', async () => {
		// The whole-iteration scan matters here: stopping the verification at row #1
		// would report "key is free" for a key the scan carries further down.
		await db.exec(`insert into t values (1, 'one')`);
		await db.exec(`insert into t values (2, 'two')`);
		await db.exec(`insert into t values (3, 'three')`);
		await db.exec('begin');
		await expectConstraintFailure(() => db.exec(`insert into t values (3, 'again')`), DUPLICATE_PK);
		await db.exec('rollback');
		expect(await rows()).to.deep.equal([[1, 'one'], [2, 'two'], [3, 'three']]);
	});
});

describe('isolation PK probe vs an underlying that scans — compound PK', () => {
	let db: Database;

	beforeEach(async () => {
		db = await openScanOnlyUnderlyingDb(
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
		await expectConstraintFailure(() => db.exec(`insert into t values (1, 2, 'again')`), DUPLICATE_PK);
	});
});

describe('isolation PK probe vs an underlying that scans — NOCASE text PK', () => {
	let db: Database;

	beforeEach(async () => {
		db = await openScanOnlyUnderlyingDb(
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
		await expectConstraintFailure(() => db.exec(`insert into t values ('APPLE', 'other')`), DUPLICATE_PK);
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

describe('isolation PK probe vs an underlying that scans — semantic-ordering (TIMESPAN) PK', () => {
	let db: Database;

	beforeEach(async () => {
		db = await openScanOnlyUnderlyingDb('create table t (d timespan primary key, v text) using isolated');
	});

	afterEach(async () => {
		await db.close();
	});

	async function values(): Promise<SqlValue[]> {
		const out = await asyncIterableToArray(db.eval('select v from t order by d'));
		return out.map((r: Record<string, SqlValue>) => r.v);
	}

	/**
	 * The column shape the original report came from: a TIMESPAN orders by elapsed time
	 * rather than by stored bytes, so 'PT2H' and 'PT120M' are ONE key with two spellings
	 * and a module that cannot seek it is right to decline. The probe must therefore
	 * compare through the type's own comparator, not the collation path.
	 */
	it('a re-spelled duplicate key is a duplicate, not a fresh key', async () => {
		await db.exec(`insert into t values ('PT2H', 'two hours')`);
		await expectConstraintFailure(() => db.exec(`insert into t values ('PT120M', 'again')`), DUPLICATE_PK);
		expect(await values()).to.deep.equal(['two hours']);
	});

	it('a staged re-spelling of the key stays one row', async () => {
		await db.exec(`insert into t values ('PT2H', 'two hours')`);
		await db.exec('begin');
		await db.exec(`update t set d = 'PT120M' where d = 'PT2H'`);
		await db.exec('commit');
		expect(await values()).to.deep.equal(['two hours']);
	});

	it('genuinely distinct spans both land', async () => {
		await db.exec('begin');
		await db.exec(`insert into t values ('PT1H', 'one hour')`);
		await db.exec(`insert into t values ('PT2H', 'two hours')`);
		await db.exec('commit');
		expect(await values()).to.deep.equal(['one hour', 'two hours']);
	});
});

describe('isolation reads vs an OVERLAY that scans', () => {
	let db: Database;

	beforeEach(async () => {
		db = await openScanOnlyOverlayDb('create table t (k integer primary key, v text) using isolated');
	});

	afterEach(async () => {
		await db.close();
	});

	async function rows(sql: string): Promise<SqlValue[][]> {
		const out = await asyncIterableToArray(db.eval(sql));
		return out.map((r: Record<string, SqlValue>) => [r.k, r.v]);
	}

	it('a staged PK-point read returns only the matching row', async () => {
		// The merged primary read hands the overlay the FilterInfo the UNDERLYING
		// negotiated. The engine dropped the residual on the underlying's claim, so
		// trusting the overlay's answer surfaces every staged row instead of the one asked
		// for. The layer re-applies the window itself.
		await db.exec(`insert into t values (1, 'one')`);
		await db.exec('begin');
		await db.exec(`insert into t values (2, 'two')`);
		await db.exec(`insert into t values (3, 'three')`);
		const seeked = await rows('select k, v from t where k = 2');
		const scanned = await rows('select k, v from t order by k');
		await db.exec('rollback');

		expect(seeked, 'the seek must not leak the other staged rows').to.deep.equal([[2, 'two']]);
		// The unwindowed read still sees everything — the window filter narrows, never drops.
		expect(scanned).to.deep.equal([[1, 'one'], [2, 'two'], [3, 'three']]);
	});

	it('a staged row is still visible to a point read that asks for it', async () => {
		await db.exec(`insert into t values (1, 'one')`);
		await db.exec('begin');
		await db.exec(`insert into t values (2, 'two')`);
		expect(await rows('select k, v from t where k = 2')).to.deep.equal([[2, 'two']]);
		// A staged UPDATE shadows the committed row rather than duplicating it.
		await db.exec(`update t set v = 'ONE' where k = 1`);
		expect(await rows('select k, v from t where k = 1')).to.deep.equal([[1, 'ONE']]);
		// A staged DELETE's tombstone still suppresses the committed row, though a
		// tombstone carries null non-PK columns and so bypasses the window filter.
		await db.exec('delete from t where k = 1');
		expect(await rows('select k, v from t where k = 1')).to.deep.equal([]);
		await db.exec('rollback');
	});

	it('staged rows commit through a scan-only overlay', async () => {
		// `getOverlayRow` and the commit flush's overlay collection both read this
		// overlay; neither may believe an unverified row.
		await db.exec(`insert into t values (1, 'one')`);
		await db.exec('begin');
		await db.exec(`insert into t values (2, 'two')`);
		await db.exec(`insert into t values (3, 'three')`);
		await db.exec('commit');
		expect(await rows('select k, v from t order by k')).to.deep.equal([[1, 'one'], [2, 'two'], [3, 'three']]);
	});

	it('sanity: a duplicate against a staged row still conflicts', async () => {
		await db.exec('begin');
		await db.exec(`insert into t values (1, 'one')`);
		await db.exec(`insert into t values (2, 'two')`);
		await expectConstraintFailure(() => db.exec(`insert into t values (1, 'again')`), DUPLICATE_PK);
		await db.exec('rollback');
	});

	it('sanity: a duplicate against a committed row still conflicts', async () => {
		await db.exec(`insert into t values (1, 'one')`);
		await db.exec('begin');
		await db.exec(`insert into t values (2, 'two')`);
		await expectConstraintFailure(() => db.exec(`insert into t values (1, 'again')`), DUPLICATE_PK);
		await db.exec('rollback');
	});
});
